import '../shared/i18n.js';
import { detectSourceLanguage, resolveTargets } from '../shared/lang.js';
import { buildPagePrompt, buildSystemPrompt, clampInput, isDictionaryCandidate } from '../shared/prompt.js';
import { MAX_BATCH_CHARS, MAX_BATCH_SEGMENTS, buildSegmentsInput, createSegmentParser } from '../shared/segments.js';
import { effectiveProvider, isProviderReady, loadSettings } from '../shared/settings.js';
import { buildChatRequest, DEFAULT_TIMEOUT_SECONDS, streamChat, TranslationError } from '../shared/translator.js';

const PORT_NAME = 'glint:translate';
const PAGE_PORT_NAME = 'glint:page';
const MENU_ID = 'glint-translate-selection';
const PAGE_MENU_ID = 'glint-translate-page';
const CONTENT_SCRIPTS = chrome.runtime.getManifest().content_scripts[0].js;

// Recent results, so reopening the same selection (or revisiting a page) is
// instant. Lost whenever the worker is suspended, which is fine.
const cache = new Map();
const segmentCache = new Map();

function remember(store, limit, key, value) {
  store.delete(key);
  store.set(key, value);
  if (store.size > limit) store.delete(store.keys().next().value);
}

const { errorText, resolveLocale, translate } = globalThis.GLINT_I18N;

function localeOf(settings) {
  return resolveLocale(settings.uiLang, chrome.i18n.getUILanguage());
}

// Error messages are sent ready to display, in the interface language.
function errorPayload(err, locale) {
  const code = err instanceof TranslationError ? err.code : 'unknown';
  const detail = err instanceof TranslationError ? err.detail : String(err?.message || err);
  return { type: 'error', code, message: errorText(locale, code), detail };
}

// Transient failures get more attempts: the server stalled, the connection
// dropped, rate limits and server errors. Waits before attempts 2 and 3.
const RETRY_DELAYS_MS = [1000, 3000];

function retryable(err) {
  const code = err instanceof TranslationError ? err.code : '';
  return ['timeout', 'network', 'http_408', 'http_429'].includes(code) || /^http_5\d\d$/.test(code);
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function timeoutMsOf(settings) {
  const seconds = Number(settings.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS;
  return Math.min(Math.max(seconds, 1), 600) * 1000;
}

function notConfigured(locale) {
  return { type: 'error', code: 'not_configured', message: errorText(locale, 'not_configured'), detail: translate(locale, 'error.not_configured.detail') };
}

// Extension API calls reset the worker's idle timer; slow first tokens
// must not get the worker suspended mid-request.
function keepAlive() {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  return () => clearInterval(timer);
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.contextMenus.removeAll();
  const locale = localeOf(await loadSettings());
  chrome.contextMenus.create({ id: MENU_ID, title: translate(locale, 'menu.selection'), contexts: ['selection'] });
  chrome.contextMenus.create({ id: PAGE_MENU_ID, title: translate(locale, 'menu.page'), contexts: ['page'] });
  if (reason === 'install' || reason === 'update') await injectIntoOpenTabs();
  if (reason === 'install' && !isProviderReady(await loadSettings())) chrome.runtime.openOptionsPage();
});

// Content scripts only load on navigation, so tabs that were already open
// get them injected (replacing stale copies after an update).
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: CONTENT_SCRIPTS }).catch(() => {}),
    ),
  );
}

async function sendToTab(tabId, message, frameId) {
  const options = frameId === undefined ? {} : { frameId };
  try {
    await chrome.tabs.sendMessage(tabId, message, options);
  } catch {
    // No receiver yet: inject and retry once. Restricted pages (chrome://,
    // the Web Store) reject both calls, and there is nothing to do there.
    try {
      const target = frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
      await chrome.scripting.executeScript({ target, files: CONTENT_SCRIPTS });
      await chrome.tabs.sendMessage(tabId, message, options);
    } catch {
      // Ignore.
    }
  }
}

// Menu titles follow the interface language.
chrome.storage.onChanged.addListener((changes, area) => {
  const { oldValue, newValue } = changes.settings || {};
  if (area !== 'local' || !newValue || oldValue?.uiLang === newValue.uiLang) return;
  const locale = localeOf(newValue);
  chrome.contextMenus.update(MENU_ID, { title: translate(locale, 'menu.selection') }).catch(() => {});
  chrome.contextMenus.update(PAGE_MENU_ID, { title: translate(locale, 'menu.page') }).catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id === undefined) return;
  if (info.menuItemId === MENU_ID) sendToTab(tab.id, { type: 'glint:show', text: info.selectionText || '' }, info.frameId);
  // Page translation lives in the top frame only.
  else if (info.menuItemId === PAGE_MENU_ID) sendToTab(tab.id, { type: 'glint:page', action: 'toggle' }, 0);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'translate-selection' && command !== 'translate-page') return;
  const target = tab?.id !== undefined ? tab : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (target?.id === undefined) return;
  if (command === 'translate-page') sendToTab(target.id, { type: 'glint:page', action: 'toggle' }, 0);
  else sendToTab(target.id, { type: 'glint:translate-selection' });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'glint:open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PAGE_PORT_NAME) {
    handlePagePort(port);
    return;
  }
  if (port.name !== PORT_NAME) return;
  let controller = null;
  port.onMessage.addListener((message) => {
    if (message?.type === 'translate') {
      controller?.abort();
      controller = new AbortController();
      runTranslation(port, message, controller.signal);
    } else if (message?.type === 'cancel') {
      controller?.abort();
    }
  });
  port.onDisconnect.addListener(() => controller?.abort());
});

/**
 * Port protocol (all messages carry the request id):
 *   in:  { type: 'translate', id, text, targetLang?, fresh? } | { type: 'cancel' }
 *   out: { type: 'meta', sourceLang, targetLang, mode, model, protocol }
 *        { type: 'delta', text } … { type: 'done', text, cached }
 *        { type: 'error', code, message, detail }
 */
async function runTranslation(port, message, signal) {
  const { id } = message;
  const post = (payload) => {
    if (signal.aborted) return;
    try {
      port.postMessage({ id, ...payload });
    } catch {
      // The page went away.
    }
  };

  // Every request gets an answer, even when something unexpected throws;
  // otherwise the card would wait forever.
  let locale = localeOf({});
  const release = keepAlive();
  try {
    const settings = await loadSettings();
    locale = localeOf(settings);
    await translateText(settings, message, signal, post);
  } catch (err) {
    if (!signal.aborted) post(errorPayload(err, locale));
  } finally {
    release();
  }
}

async function translateText(settings, message, signal, post) {
  const locale = localeOf(settings);
  if (!isProviderReady(settings)) {
    post(notConfigured(locale));
    return;
  }
  const text = clampInput(message.text);
  if (!text) {
    post({ type: 'error', code: 'empty', message: errorText(locale, 'empty'), detail: '' });
    return;
  }

  const provider = effectiveProvider(settings.provider);
  const sourceLang = await detectSourceLanguage(text, (t) => chrome.i18n.detectLanguage(t));
  const { target, fallback } = resolveTargets({
    sourceLang,
    targetLang: message.targetLang || settings.targetLang,
    secondLang: settings.secondLang,
    forceTarget: Boolean(message.targetLang),
  });
  const mode = settings.dictionary && isDictionaryCandidate(text) ? 'dictionary' : 'translate';
  post({ type: 'meta', sourceLang, targetLang: target, mode, model: provider.model, protocol: provider.type });

  const template = settings.prompts[mode] || '';
  const key = JSON.stringify([provider.baseUrl, provider.model, mode, template, target, text]);
  if (!message.fresh && cache.has(key)) {
    const cached = cache.get(key);
    remember(cache, 100, key, cached);
    post({ type: 'delta', text: cached });
    post({ type: 'done', text: cached, cached: true });
    return;
  }

  const system = buildSystemPrompt({ mode, target, fallback, source: sourceLang, template });
  const request = buildChatRequest({ ...provider, system, text });
  const timeoutMs = timeoutMsOf(settings);
  let full = '';
  for (let attempt = 0; ; attempt++) {
    try {
      for await (const delta of streamChat({ request, signal, timeoutMs })) {
        full += delta;
        post({ type: 'delta', text: delta });
      }
      break;
    } catch (err) {
      // Once text is on screen a retry would repeat it; report instead.
      if (signal.aborted || full || !retryable(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
      await wait(RETRY_DELAYS_MS[attempt], signal);
    }
  }
  if (!full.trim()) throw new TranslationError('empty_response');
  remember(cache, 100, key, full);
  post({ type: 'done', text: full, cached: false });
}

/**
 * Whole-page port. Several batches may be in flight at once.
 *   in:  { type: 'batch', id, segments: string[], title?, targetLang? } | { type: 'cancel', id? }
 *   out: { type: 'segment', id, index, text }   (index into segments)
 *        { type: 'done', id, missing: number[] } | { type: 'error', id, code, message, detail }
 */
function handlePagePort(port) {
  const controllers = new Map();
  port.onMessage.addListener((message) => {
    if (message?.type === 'batch') {
      const controller = new AbortController();
      controllers.set(message.id, controller);
      runBatch(port, message, controller.signal).finally(() => controllers.delete(message.id));
    } else if (message?.type === 'cancel') {
      for (const [id, controller] of controllers) {
        if (message.id === undefined || message.id === id) controller.abort();
      }
    }
  });
  port.onDisconnect.addListener(() => {
    for (const controller of controllers.values()) controller.abort();
  });
}

async function runBatch(port, message, signal) {
  const { id } = message;
  const post = (payload) => {
    if (signal.aborted) return;
    try {
      port.postMessage({ id, ...payload });
    } catch {
      // The page went away.
    }
  };

  let locale = localeOf({});
  const release = keepAlive();
  try {
    const settings = await loadSettings();
    locale = localeOf(settings);
    await translateBatch(settings, message, signal, post);
  } catch (err) {
    if (!signal.aborted) post(errorPayload(err, locale));
  } finally {
    release();
  }
}

async function translateBatch(settings, message, signal, post) {
  if (!isProviderReady(settings)) {
    post(notConfigured(localeOf(settings)));
    return;
  }
  const segments = (Array.isArray(message.segments) ? message.segments : [])
    .slice(0, MAX_BATCH_SEGMENTS)
    .map((text) => String(text).trim().slice(0, MAX_BATCH_CHARS));
  const provider = effectiveProvider(settings.provider);
  const target = message.targetLang || settings.targetLang;
  const template = settings.prompts.page || '';
  const keyOf = (text) => JSON.stringify([provider.baseUrl, provider.model, 'page', template, target, text]);

  // Serve what is cached; only the rest goes to the model.
  let pending = [];
  segments.forEach((text, index) => {
    const cached = segmentCache.get(keyOf(text));
    if (cached !== undefined) post({ type: 'segment', index, text: cached });
    else pending.push(index);
  });

  const system = buildPagePrompt({ target, title: message.title, template });
  const timeoutMs = timeoutMsOf(settings);
  const delivered = new Set();
  for (let attempt = 0; pending.length; attempt++) {
    const asked = pending;
    const parser = createSegmentParser(asked.length);
    const emit = (found) => {
      for (const { index, text } of found) {
        const original = asked[index];
        delivered.add(original);
        remember(segmentCache, 3000, keyOf(segments[original]), text);
        post({ type: 'segment', index: original, text });
      }
    };
    try {
      const request = buildChatRequest({ ...provider, system, text: buildSegmentsInput(asked.map((i) => segments[i])), maxTokens: 4096 });
      for await (const delta of streamChat({ request, signal, timeoutMs })) emit(parser.push(delta));
      emit(parser.finish());
      post({ type: 'done', missing: parser.missing().map((i) => asked[i]) });
      return;
    } catch (err) {
      if (signal.aborted || !retryable(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
      // Paragraphs that already arrived are kept; ask only for the rest.
      pending = asked.filter((i) => !delivered.has(i));
      await wait(RETRY_DELAYS_MS[attempt], signal);
    }
  }
  post({ type: 'done', missing: [] });
}
