import { LANGUAGES, languageLabel } from '../shared/lang.js';
import { PROTOCOL_LABELS } from '../shared/providers.js';
import { effectiveProvider, isProviderReady, loadSettings, updateSettings } from '../shared/settings.js';
import { applyTheme, renderResult, translateStream } from '../ui/common.js';

const $ = (id) => document.getElementById(id);
const TRIGGER_DESC = { icon: '选中文本后显示翻译图标', auto: '选中文本后直接翻译', manual: '仅快捷键与右键菜单' };

let settings;
let hostname = '';
let cancel = null;
let lastResult = '';
let tab = null;

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
    $('statusText').textContent = '尚未配置模型服务';
    return;
  }
  const provider = effectiveProvider(settings.provider);
  $('statusText').textContent = `${provider.model} · ${PROTOCOL_LABELS[provider.type]}`;
  $('statusText').title = provider.baseUrl;
}

function renderToggles() {
  $('enabled').checked = settings.enabled;
  $('triggerDesc').textContent = settings.enabled ? TRIGGER_DESC[settings.trigger] : '已关闭，仍可用快捷键与右键菜单';
  $('siteRow').hidden = !hostname;
  $('siteHost').textContent = hostname;
  $('siteEnabled').checked = !settings.disabledSites.includes(hostname);
  $('siteEnabled').disabled = !settings.enabled;
  $('ballRow').hidden = !hostname;
  $('ballEnabled').checked = settings.floatBall && !settings.ballDisabledSites.includes(hostname);
}

// Talks to the page-translation script in the tab's top frame, injecting
// the content scripts first when the tab predates the extension.
async function pageMessage(action) {
  const message = { type: 'glint:page', action };
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

function renderPageButton(state) {
  const button = $('pageButton');
  button.hidden = false;
  button.disabled = !state;
  button.dataset.active = String(Boolean(state?.active));
  $('pageTitle').textContent = !state ? '此页面不支持网页翻译' : state.active ? '显示原文' : '翻译此网页';
  $('pageDesc').textContent = !state
    ? '浏览器内置页面和应用商店无法注入脚本'
    : state.active
      ? `已开启双语对照 · 译为${languageLabel(settings.targetLang)}`
      : '双语对照，滚动到哪里翻译到哪里';
}

async function initPageButton() {
  const commands = await chrome.commands.getAll();
  $('pageKbd').textContent = commands.find((c) => c.name === 'translate-page')?.shortcut || '';
  if (!hostname) {
    renderPageButton(null);
    return;
  }
  renderPageButton(await pageMessage('status'));
  $('pageButton').addEventListener('click', async () => {
    const state = await pageMessage('toggle');
    renderPageButton(state);
    if (state?.active) window.close();
  });
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
  $('resultMeta').textContent = '翻译中…';
  $('copy').hidden = true;
  cancel = translateStream(
    { text, targetLang: $('targetLang').value },
    {
      onMeta: (meta) => {
        mode = meta.mode;
        $('resultMeta').textContent = `${languageLabel(meta.sourceLang)} → ${languageLabel(meta.targetLang)}`;
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
  applyTheme(settings.theme);
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
  if (ready) initPageButton();

  const select = $('targetLang');
  select.replaceChildren(
    ...LANGUAGES.map((lang) => Object.assign(document.createElement('option'), { value: lang.code, textContent: lang.label })),
  );
  select.value = settings.targetLang;
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
