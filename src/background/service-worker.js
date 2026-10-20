import { detectSourceLanguage, resolveTargets } from '../shared/lang.js';
import { buildPagePrompt, buildSystemPrompt, clampInput, isDictionaryCandidate } from '../shared/prompt.js';
import { MAX_BATCH_CHARS, MAX_BATCH_SEGMENTS, buildSegmentsInput, createSegmentParser } from '../shared/segments.js';
import { effectiveProvider, isProviderReady, loadSettings } from '../shared/settings.js';
import { buildChatRequest, streamChat, TranslationError } from '../shared/translator.js';

const PORT_NAME = 'glint:translate';
const PAGE_PORT_NAME = 'glint:page';
const MENU_ID = 'glint-translate-selection';
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

const NOT_CONFIGURED = { type: 'error', code: 'not_configured', message: '还没有配置模型服务', detail: '在设置页填写 API 地址、Key 并选择模型后即可使用' };

function errorPayload(err) {
  const known = err instanceof TranslationError;
  return {
    type: 'error',
    code: known ? err.code : 'unknown',
    message: known ? err.message : '翻译失败',
    detail: known ? err.detail : String(err?.message || err),
  };
}

// Extension API calls reset the worker's idle timer; slow first tokens
// must not get the worker suspended mid-request.
function keepAlive() {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  return () => clearInterval(timer);
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_ID, title: '用 Glint 翻译“%s”', contexts: ['selection'] });
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

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined) return;
  sendToTab(tab.id, { type: 'glint:show', text: info.selectionText || '' }, info.frameId);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'translate-selection') return;
  const target = tab?.id !== undefined ? tab : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (target?.id !== undefined) sendToTab(target.id, { type: 'glint:translate-selection' });
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

  const settings = await loadSettings();
  if (!isProviderReady(settings)) {
    post(NOT_CONFIGURED);
    return;
  }
  const text = clampInput(message.text);
  if (!text) {
    post({ type: 'error', code: 'empty', message: '没有可翻译的文本', detail: '' });
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

  const key = JSON.stringify([provider.baseUrl, provider.model, mode, target, text]);
  if (!message.fresh && cache.has(key)) {
    const cached = cache.get(key);
    remember(cache, 100, key, cached);
    post({ type: 'delta', text: cached });
    post({ type: 'done', text: cached, cached: true });
    return;
  }

  const release = keepAlive();
  try {
    const request = buildChatRequest({ ...provider, system: buildSystemPrompt({ mode, target, fallback }), text });
    let full = '';
    for await (const delta of streamChat({ request, signal })) {
      full += delta;
      post({ type: 'delta', text: delta });
    }
    if (!full.trim()) throw new TranslationError('empty_response', '模型没有返回内容', '');
    remember(cache, 100, key, full);
    post({ type: 'done', text: full, cached: false });
  } catch (err) {
    if (!signal.aborted) post(errorPayload(err));
  } finally {
    release();
  }
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

  const settings = await loadSettings();
  if (!isProviderReady(settings)) {
    post(NOT_CONFIGURED);
    return;
  }
  const segments = (Array.isArray(message.segments) ? message.segments : [])
    .slice(0, MAX_BATCH_SEGMENTS)
    .map((text) => String(text).trim().slice(0, MAX_BATCH_CHARS));
  const provider = effectiveProvider(settings.provider);
  const target = message.targetLang || settings.targetLang;
  const keyOf = (text) => JSON.stringify([provider.baseUrl, provider.model, 'page', target, text]);

  // Serve what is cached; only the rest goes to the model.
  const pending = [];
  segments.forEach((text, index) => {
    const cached = segmentCache.get(keyOf(text));
    if (cached !== undefined) post({ type: 'segment', index, text: cached });
    else pending.push(index);
  });
  if (!pending.length) {
    post({ type: 'done', missing: [] });
    return;
  }

  const release = keepAlive();
  try {
    const request = buildChatRequest({
      ...provider,
      system: buildPagePrompt({ target, title: message.title }),
      text: buildSegmentsInput(pending.map((i) => segments[i])),
      maxTokens: 4096,
    });
    const parser = createSegmentParser(pending.length);
    const emit = (found) => {
      for (const { index, text } of found) {
        const original = pending[index];
        remember(segmentCache, 3000, keyOf(segments[original]), text);
        post({ type: 'segment', index: original, text });
      }
    };
    for await (const delta of streamChat({ request, signal })) emit(parser.push(delta));
    emit(parser.finish());
    post({ type: 'done', missing: parser.missing().map((i) => pending[i]) });
  } catch (err) {
    if (!signal.aborted) post(errorPayload(err));
  } finally {
    release();
  }
}
