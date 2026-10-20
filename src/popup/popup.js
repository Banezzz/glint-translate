import { LANGUAGES, languageLabel } from '../shared/lang.js';
import { effectiveProvider, isProviderReady, loadSettings, updateSettings } from '../shared/settings.js';
import { applyTheme, renderResult, translateStream } from '../ui/common.js';
import { applyI18n, getLocale, protocolLabel, setLocale, t } from '../ui/i18n.js';
import { initQuickToggles } from '../ui/quick-toggles.js';

const $ = (id) => document.getElementById(id);

let settings;
let hostname = '';
let cancel = null;
let lastResult = '';
let lastMeta = null;
let tab = null;
// Last state reported by the page, so a language switch can re-render it.
let pageState;

const label = (code) => languageLabel(code, getLocale());

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Prefills the box with whatever is selected on the current page.
async function pageSelection(tab) {
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return '';
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString() ?? '',
    });
    return String(result || '').trim();
  } catch {
    return '';
  }
}

function renderStatus() {
  const ready = isProviderReady(settings);
  $('statusDot').className = `dot ${ready ? 'ok' : 'warn'}`;
  if (!ready) {
    $('statusText').textContent = t('popup.notConfigured');
    return;
  }
  const provider = effectiveProvider(settings.provider);
  $('statusText').textContent = `${provider.model} · ${protocolLabel(provider.type)}`;
  $('statusText').title = provider.baseUrl;
}

function renderToggles() {
  $('enabled').checked = settings.enabled;
  $('triggerDesc').textContent = t(settings.enabled ? `popup.trigger.${settings.trigger}` : 'popup.trigger.off');
  $('siteRow').hidden = !hostname;
  $('siteHost').textContent = hostname;
  $('siteEnabled').checked = !settings.disabledSites.includes(hostname);
  $('siteEnabled').disabled = !settings.enabled;
  $('ballRow').hidden = !hostname;
  $('ballEnabled').checked = settings.floatBall && !settings.ballDisabledSites.includes(hostname);
}

// Talks to the page-translation script in the tab's top frame, injecting
// the content scripts first when the tab predates the extension.
async function pageMessage(action, extra = {}) {
  const message = { type: 'glint:page', action, ...extra };
  try {
    return await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
  } catch {
    try {
      const files = chrome.runtime.getManifest().content_scripts[0].js;
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
      return await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
    } catch {
      return null;
    }
  }
}

function renderPageCard(state) {
  pageState = state;
  $('pageCard').hidden = false;
  $('pageCard').classList.toggle('unsupported', !state);
  for (const radio of document.querySelectorAll('input[name="pageView"]')) {
    radio.checked = radio.value === (state?.view || 'original');
    radio.disabled = !state;
  }
  $('pageDesc').textContent = !state
    ? t('popup.page.unsupported')
    : t(state.view === 'original' ? 'popup.page.idle' : 'popup.page.active', { lang: label(settings.targetLang) });
}

function renderMeta() {
  $('resultMeta').textContent = lastMeta ? `${label(lastMeta.sourceLang)} → ${label(lastMeta.targetLang)}` : '';
}

function fillTargetSelect() {
  const select = $('targetLang');
  const value = select.value || settings.targetLang;
  select.replaceChildren(...LANGUAGES.map((lang) => Object.assign(document.createElement('option'), { value: lang.code, textContent: label(lang.code) })));
  select.value = value;
}

// Re-renders everything that carries text, in place.
function applyLocale(preference) {
  setLocale(preference);
  applyI18n();
  renderStatus();
  renderToggles();
  fillTargetSelect();
  if (pageState !== undefined) renderPageCard(pageState);
  if (lastMeta) renderMeta();
}

async function initPageCard() {
  const commands = await chrome.commands.getAll();
  $('pageKbd').textContent = commands.find((c) => c.name === 'translate-page')?.shortcut || '';
  if (!hostname) {
    renderPageCard(null);
    return;
  }
  renderPageCard(await pageMessage('status'));
  for (const radio of document.querySelectorAll('input[name="pageView"]')) {
    radio.addEventListener('change', async () => renderPageCard(await pageMessage('view', { view: radio.value })));
  }
}

function translate() {
  const text = $('input').value.trim();
  if (!text) {
    $('input').focus();
    return;
  }
  cancel?.();
  lastResult = '';
  let mode = 'translate';
  const result = $('result');
  $('resultWrap').hidden = false;
  result.className = 'translation';
  renderResult(result, { mode, text: '', source: text, streaming: true });
  lastMeta = null;
  $('resultMeta').textContent = t('translating');
  $('copy').hidden = true;
  cancel = translateStream(
    { text, targetLang: $('targetLang').value },
    {
      onMeta: (meta) => {
        mode = meta.mode;
        lastMeta = meta;
        renderMeta();
      },
      onDelta: (delta) => {
        lastResult += delta;
        renderResult(result, { mode, text: lastResult, source: text, streaming: true });
      },
      onDone: (done) => {
        lastResult = done.text;
        renderResult(result, { mode, text: lastResult, source: text, streaming: false });
        $('copy').hidden = false;
        cancel = null;
      },
      onError: (error) => {
        result.className = 'translation error';
        result.textContent = error.message;
        if (error.detail) {
          const detail = document.createElement('span');
          detail.className = 'detail';
          detail.textContent = error.detail;
          result.append(detail);
        }
        $('resultMeta').textContent = '';
        cancel = null;
      },
    },
  );
}

async function init() {
  settings = await loadSettings();
  setLocale(settings.uiLang);
  applyI18n();
  applyTheme(settings.theme);
  const renderQuick = initQuickToggles({ themeButton: $('themeToggle'), languageButton: $('langToggle'), getSettings: () => settings });
  tab = await activeTab();
  try {
    const url = new URL(tab?.url || '');
    if (url.protocol === 'http:' || url.protocol === 'https:') hostname = url.hostname;
  } catch {
    // No URL access for this tab.
  }

  const ready = isProviderReady(settings);
  $('setup').hidden = ready;
  $('translate').hidden = !ready;
  renderStatus();
  renderToggles();
  if (ready) initPageCard();

  const select = $('targetLang');
  select.value = '';
  fillTargetSelect();
  $('kbd').textContent = /Mac/i.test(navigator.platform) ? '⌘ ↵' : 'Ctrl ↵';

  const openOptions = () => {
    chrome.runtime.openOptionsPage();
    window.close();
  };
  $('openOptions').addEventListener('click', openOptions);
  $('setupButton').addEventListener('click', openOptions);
  $('translateButton').addEventListener('click', translate);
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      translate();
    }
  });
  select.addEventListener('change', async () => {
    settings = await updateSettings({ targetLang: select.value });
    if ($('input').value.trim() && !$('resultWrap').hidden) translate();
  });
  $('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(lastResult);
    $('copy').classList.add('done');
    setTimeout(() => $('copy').classList.remove('done'), 1200);
  });
  $('enabled').addEventListener('change', async (e) => {
    settings = await updateSettings({ enabled: e.target.checked });
    renderToggles();
  });
  $('siteEnabled').addEventListener('change', async (e) => {
    const sites = new Set(settings.disabledSites);
    if (e.target.checked) sites.delete(hostname);
    else sites.add(hostname);
    settings = await updateSettings({ disabledSites: [...sites] });
    renderToggles();
  });
  $('ballEnabled').addEventListener('change', async (e) => {
    const sites = new Set(settings.ballDisabledSites);
    if (e.target.checked) sites.delete(hostname);
    else sites.add(hostname);
    // Turning it on for a site also brings back a globally hidden ball.
    settings = await updateSettings({ ballDisabledSites: [...sites], ...(e.target.checked ? { floatBall: true } : {}) });
    renderToggles();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    const next = changes.settings?.newValue;
    if (area !== 'local' || !next) return;
    const previous = settings;
    settings = { ...settings, ...next };
    if (next.uiLang !== previous.uiLang) applyLocale(next.uiLang);
    if (next.theme !== previous.theme) applyTheme(next.theme);
    renderQuick();
  });

  if (ready) {
    const selected = await pageSelection(tab);
    if (selected) {
      $('input').value = selected.slice(0, 6000);
      translate();
    } else {
      $('input').focus();
    }
  }
}

init();
