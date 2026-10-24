import { LANGUAGES, languageLabel } from '../shared/lang.js';
import { DEFAULT_PROMPTS, PROMPT_FORMATS, PROMPT_MODES, PROMPT_VARIABLES } from '../shared/prompt.js';
import { chooseModel, detectEndpoint, normalizeBaseUrl } from '../shared/providers.js';
import { loadSettings, updateSettings } from '../shared/settings.js';
import { applyTheme, debounce, relativeTime, renderResult, translateStream } from '../ui/common.js';
import { applyI18n, getLocale, protocolLabel, setLocale, t } from '../ui/i18n.js';
import { initQuickToggles } from '../ui/quick-toggles.js';

const PRESETS = [
  { name: 'OpenAI', url: 'https://api.openai.com/v1' },
  { name: 'Anthropic', url: 'https://api.anthropic.com/v1' },
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { name: 'SiliconFlow', key: 'preset.siliconflow', url: 'https://api.siliconflow.cn/v1' },
  { name: 'Ollama', url: 'http://localhost:11434/v1' },
];

const $ = (id) => document.getElementById(id);
const isMac = /Mac/i.test(navigator.platform);

let settings;
let saveQueue = Promise.resolve();
let detectController = null;
let detectSeq = 0;

// ------------------------------------------------------------------ saving

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

// Serialized so concurrent edits never overwrite each other.
function save(patch, { quiet = false } = {}) {
  saveQueue = saveQueue.then(async () => {
    settings = await updateSettings(patch);
    if (!quiet) toast(t('toast.saved'));
  });
  return saveQueue;
}

const saveBaseUrl = debounce(() => save({ provider: { baseUrl: $('baseUrl').value.trim() } }), 400);
const saveApiKey = debounce(() => save({ provider: { apiKey: $('apiKey').value.trim() } }), 400);
const saveModel = debounce(() => save({ provider: { model: $('model').value.trim() } }), 500);
const saveFontSize = debounce(() => save({ fontSize: Number($('fontSize').value) }), 300);
const scheduleDetect = debounce(() => runDetect(), 800);

function flushPendingSaves() {
  saveBaseUrl.flush();
  saveApiKey.flush();
  saveModel.flush();
  savePrompt.flush();
  return saveQueue;
}

// --------------------------------------------------------------- provider

function currentType() {
  return document.querySelector('input[name="type"]:checked')?.value ?? 'auto';
}

function renderPresets() {
  const normalized = normalizeBaseUrl($('baseUrl').value);
  $('presets').replaceChildren(
    ...PRESETS.map((preset) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset';
      button.textContent = preset.key ? t(preset.key) : preset.name;
      button.title = preset.url;
      button.setAttribute('aria-pressed', String(normalizeBaseUrl(preset.url) === normalized));
      button.addEventListener('click', () => {
        $('baseUrl').value = preset.url;
        document.querySelector('input[name="type"][value="auto"]').checked = true;
        renderPresets();
        saveBaseUrl.cancel();
        save({ provider: { baseUrl: preset.url, type: 'auto' } });
        if (!$('apiKey').value) $('apiKey').focus();
        scheduleDetect.flush();
      });
      return button;
    }),
  );
}

function setConnection(state, { title = '', sub = '' } = {}) {
  $('connection').dataset.state = state;
  $('connSpinner').hidden = state !== 'checking';
  const dot = $('connDot');
  dot.hidden = state === 'checking';
  dot.className = `dot ${state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : state === 'error' ? 'error' : ''}`;
  $('connTitle').textContent = title;
  $('connSub').textContent = sub;
  $('connSub').title = sub;
  $('detect').disabled = state === 'checking';
}

function renderConnectionFromSettings() {
  const { provider } = settings;
  const normalized = normalizeBaseUrl(provider.baseUrl);
  if (!normalized) {
    setConnection('idle', { title: t(provider.baseUrl ? 'conn.badUrl' : 'conn.idle') });
    return;
  }
  const resolved = provider.resolved?.from === normalized ? provider.resolved : null;
  if (!resolved) {
    setConnection('idle', { title: t('conn.unchecked'), sub: normalized });
    return;
  }
  const type = provider.type === 'auto' ? resolved.type : provider.type;
  const count = provider.models.length;
  const title = [t('conn.connected', { protocol: protocolLabel(type) }), count ? t('model.count', { count }) : ''].filter(Boolean).join(' · ');
  const details = [resolved.baseUrl, resolved.latencyMs ? `${resolved.latencyMs} ms` : '', resolved.checkedAt ? t('conn.checkedAt', { time: relativeTime(resolved.checkedAt) }) : '']
    .filter(Boolean)
    .join(' · ');
  setConnection(resolved.warning ? 'warn' : 'ok', { title, sub: resolved.warning ? warningText(resolved.warning) : details });
}

// Detection used to store the warning as text; newer versions store a code.
function warningText(warning) {
  const key = `detect.warning.${warning}`;
  const text = t(key);
  return text === key ? warning : text;
}

function detectErrorTitle({ code, params = {} }) {
  if (code === 'auth') return params.protocol ? t('detect.auth_protocol', { protocol: protocolLabel(params.protocol) }) : t('detect.auth');
  if (code === 'network') return t(params.timedOut ? 'detect.timeout' : 'detect.unreachable');
  return t(`detect.${code}`, params);
}

// Typing invalidates the shown status right away; detection runs once the
// user pauses.
function queueDetect() {
  detectController?.abort();
  detectSeq++;
  const normalized = normalizeBaseUrl($('baseUrl').value);
  if (!normalized) {
    scheduleDetect.cancel();
    setConnection('idle', { title: t($('baseUrl').value.trim() ? 'conn.badUrl' : 'conn.idle') });
    return;
  }
  setConnection('checking', { title: t('conn.checking'), sub: normalized });
  scheduleDetect();
}

async function runDetect() {
  scheduleDetect.cancel();
  const baseUrl = $('baseUrl').value.trim();
  const apiKey = $('apiKey').value.trim();
  if (!baseUrl) {
    renderConnectionFromSettings();
    return;
  }
  detectController?.abort();
  detectController = new AbortController();
  const seq = ++detectSeq;
  setConnection('checking', { title: t('conn.checking'), sub: normalizeBaseUrl(baseUrl) });

  let result;
  try {
    result = await detectEndpoint({ baseUrl, apiKey, type: currentType(), signal: detectController.signal });
  } catch (err) {
    if (seq !== detectSeq) return;
    result = { ok: false, error: { code: 'failed', params: {}, detail: String(err?.message || err) } };
  }
  if (seq !== detectSeq) return;

  if (!result.ok) {
    await save({ provider: { baseUrl, apiKey, resolved: null } }, { quiet: true });
    setConnection('error', { title: detectErrorTitle(result.error), sub: result.error.detail });
    return;
  }
  saveModel.cancel();
  const model = chooseModel({ current: $('model').value, previousModels: settings.provider.models, models: result.models });
  await save(
    {
      provider: {
        baseUrl,
        apiKey,
        models: result.models,
        model,
        resolved: {
          from: result.normalized,
          type: result.type,
          baseUrl: result.baseUrl,
          latencyMs: result.latencyMs,
          checkedAt: Date.now(),
          warning: result.warning,
        },
      },
    },
    { quiet: true },
  );
  $('model').value = model;
  renderModelCount();
  renderConnectionFromSettings();
  toast(result.models.length ? t('toast.detectedModels', { count: result.models.length }) : t('toast.detected'));
}

// ------------------------------------------------------------ model combo

let comboActive = -1;
let comboItems = [];

function renderModelCount() {
  const count = settings.provider.models.length;
  $('modelCount').hidden = !count;
  $('modelCount').textContent = t('model.count', { count });
}

function highlight(text, query) {
  const span = document.createElement('span');
  span.className = 'combo-id';
  const index = query ? text.toLowerCase().indexOf(query) : -1;
  if (index < 0) {
    span.textContent = text;
  } else {
    const mark = document.createElement('mark');
    mark.textContent = text.slice(index, index + query.length);
    span.append(text.slice(0, index), mark, text.slice(index + query.length));
  }
  return span;
}

function openCombo({ filter = true } = {}) {
  const models = settings.provider.models;
  const list = $('modelList');
  const value = $('model').value.trim();
  const query = filter ? value.toLowerCase() : '';
  comboItems = query ? models.filter((m) => m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query)) : models;
  if (!models.length) {
    closeCombo();
    return;
  }
  comboActive = Math.max(0, comboItems.findIndex((m) => m.id === value));
  list.replaceChildren(
    ...(comboItems.length
      ? comboItems.map((model, index) => {
          const li = document.createElement('li');
          li.className = `combo-item${model.id === settings.provider.model ? ' current' : ''}`;
          li.id = `model-option-${index}`;
          li.setAttribute('role', 'option');
          li.append(highlight(model.id, query));
          if (model.name) {
            const name = document.createElement('span');
            name.className = 'combo-name';
            name.textContent = model.name;
            li.append(name);
          }
          li.addEventListener('mousedown', (e) => e.preventDefault());
          li.addEventListener('click', () => pickModel(model.id));
          return li;
        })
      : [Object.assign(document.createElement('li'), { className: 'combo-empty', textContent: t('model.noMatch') })]),
  );
  list.hidden = false;
  $('model').setAttribute('aria-expanded', 'true');
  syncComboActive();
}

function closeCombo() {
  $('modelList').hidden = true;
  $('model').setAttribute('aria-expanded', 'false');
}

function syncComboActive() {
  const items = $('modelList').querySelectorAll('.combo-item');
  items.forEach((item, index) => item.setAttribute('aria-selected', String(index === comboActive)));
  const active = items[comboActive];
  if (active) {
    active.scrollIntoView({ block: 'nearest' });
    $('model').setAttribute('aria-activedescendant', active.id);
  }
}

function pickModel(id) {
  $('model').value = id;
  closeCombo();
  saveModel.cancel();
  save({ provider: { model: id } });
}

function wireCombo() {
  const input = $('model');
  input.addEventListener('focus', () => openCombo({ filter: false }));
  input.addEventListener('click', () => $('modelList').hidden && openCombo({ filter: false }));
  input.addEventListener('blur', () => setTimeout(closeCombo, 100));
  input.addEventListener('input', () => {
    openCombo();
    saveModel();
  });
  input.addEventListener('keydown', (event) => {
    const open = !$('modelList').hidden;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return openCombo({ filter: false });
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      comboActive = (comboActive + delta + comboItems.length) % Math.max(comboItems.length, 1);
      syncComboActive();
    } else if (event.key === 'Enter') {
      if (open && comboItems[comboActive]) {
        event.preventDefault();
        pickModel(comboItems[comboActive].id);
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeCombo();
    }
  });
}

// ------------------------------------------------------------ preferences

function fillLanguageSelect(select, value) {
  select.replaceChildren(
    ...LANGUAGES.map((lang) => {
      const option = document.createElement('option');
      option.value = lang.code;
      option.textContent = languageLabel(lang.code, getLocale());
      return option;
    }),
  );
  select.value = value;
}

async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  for (const [name, id] of [['translate-selection', 'shortcut'], ['translate-page', 'pageShortcut']]) {
    const shortcut = commands.find((c) => c.name === name)?.shortcut || '';
    const el = $(id);
    if (!shortcut) {
      el.textContent = t('shortcut.none');
      continue;
    }
    const keys = shortcut.includes('+') ? shortcut.split('+') : [...shortcut];
    el.replaceChildren(...keys.map((key) => Object.assign(document.createElement('kbd'), { textContent: key })));
  }
}

function renderBallHint() {
  const hidden = settings.ballDisabledSites.length;
  $('ballHint').textContent = hidden ? t('page.ball.hintHidden', { count: hidden }) : t('page.ball.hint');
}

function checkRadio(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

// ----------------------------------------------------------------- prompts

let promptMode = 'translate';

// What gets stored: '' while the text matches the built-in default, so
// untouched prompts follow future improvements.
function customPrompt(mode, text) {
  const trimmed = text.trim();
  return trimmed === DEFAULT_PROMPTS[mode].trim() ? '' : trimmed;
}

const savePrompt = debounce(() => {
  save({ prompts: { [promptMode]: customPrompt(promptMode, $('promptInput').value) } });
}, 600);

function renderPromptStatus() {
  const custom = Boolean(customPrompt(promptMode, $('promptInput').value));
  $('promptBadge').textContent = t(custom ? 'prompt.custom' : 'prompt.default');
  $('promptBadge').dataset.state = custom ? 'custom' : 'default';
  $('promptReset').disabled = !custom;
  for (const radio of document.querySelectorAll('input[name="promptMode"]')) {
    const stored = radio.value === promptMode ? custom : Boolean(settings.prompts[radio.value]);
    radio.parentElement.classList.toggle('customized', stored);
  }
}

function renderPromptVars() {
  $('promptVars').replaceChildren(
    ...PROMPT_VARIABLES[promptMode].map((name) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'var-chip';
      chip.dataset.var = name;
      chip.append(Object.assign(document.createElement('code'), { textContent: `{{${name}}}` }), t(`prompt.var.${name}`));
      chip.addEventListener('click', () => insertVariable(name));
      return chip;
    }),
  );
}

// Shows the prompt of the selected mode; called on load and on tab switch.
function renderPromptEditor() {
  $('promptInput').value = settings.prompts[promptMode] || DEFAULT_PROMPTS[promptMode];
  $('promptFormatWrap').hidden = !PROMPT_FORMATS[promptMode];
  $('promptFormat').textContent = PROMPT_FORMATS[promptMode];
  renderPromptVars();
  renderPromptStatus();
}

function insertVariable(name) {
  const input = $('promptInput');
  input.focus();
  input.setRangeText(`{{${name}}}`, input.selectionStart, input.selectionEnd, 'end');
  input.dispatchEvent(new Event('input'));
}

function wirePromptEditor() {
  for (const radio of document.querySelectorAll('input[name="promptMode"]')) {
    radio.addEventListener('change', () => {
      savePrompt.flush();
      promptMode = PROMPT_MODES.includes(radio.value) ? radio.value : 'translate';
      renderPromptEditor();
    });
  }
  $('promptInput').addEventListener('input', () => {
    renderPromptStatus();
    savePrompt();
  });
  $('promptReset').addEventListener('click', () => {
    savePrompt.cancel();
    $('promptInput').value = DEFAULT_PROMPTS[promptMode];
    save({ prompts: { [promptMode]: '' } }, { quiet: true });
    toast(t('toast.promptReset'));
    renderPromptStatus();
  });
  renderPromptEditor();
}

// ------------------------------------------------------------------ try it

let cancelTry = null;

async function runTry() {
  const text = $('tryInput').value.trim();
  if (!text) return;
  cancelTry?.();
  await flushPendingSaves();
  const output = $('tryOutput');
  let mode = 'translate';
  let raw = '';
  $('tryOutputWrap').hidden = false;
  output.className = 'translation';
  renderResult(output, { mode, text: '', source: text, streaming: true });
  $('tryMeta').textContent = t('translating');
  $('tryButton').disabled = true;
  const finish = () => {
    $('tryButton').disabled = false;
    cancelTry = null;
  };
  cancelTry = translateStream(
    { text, fresh: true },
    {
      onMeta: (meta) => {
        mode = meta.mode;
        $('tryMeta').textContent = `${languageLabel(meta.sourceLang, getLocale())} → ${languageLabel(meta.targetLang, getLocale())} · ${meta.model}`;
      },
      onDelta: (delta) => {
        raw += delta;
        renderResult(output, { mode, text: raw, source: text, streaming: true });
      },
      onDone: (done) => {
        renderResult(output, { mode, text: done.text, source: text, streaming: false });
        finish();
      },
      onError: (error) => {
        output.className = 'translation error';
        output.textContent = error.message;
        if (error.detail) {
          const detail = document.createElement('span');
          detail.className = 'detail';
          detail.textContent = error.detail;
          output.append(detail);
        }
        $('tryMeta').textContent = '';
        finish();
      },
    },
  );
}

// ---------------------------------------------------------------- language

// Re-renders everything that carries text, in place.
function applyLocale(preference) {
  setLocale(preference);
  applyI18n();
  renderPresets();
  renderModelCount();
  renderConnectionFromSettings();
  renderBallHint();
  renderShortcuts();
  renderPromptVars();
  renderPromptStatus();
  fillLanguageSelect($('targetLang'), $('targetLang').value);
  fillLanguageSelect($('secondLang'), $('secondLang').value);
}

// -------------------------------------------------------------------- init

async function init() {
  settings = await loadSettings();
  const { provider } = settings;
  setLocale(settings.uiLang);
  applyI18n();
  applyTheme(settings.theme);
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  $('baseUrl').value = provider.baseUrl;
  $('apiKey').value = provider.apiKey;
  $('model').value = provider.model;
  checkRadio('type', provider.type);
  renderPresets();
  renderModelCount();
  renderConnectionFromSettings();

  fillLanguageSelect($('targetLang'), settings.targetLang);
  fillLanguageSelect($('secondLang'), settings.secondLang);
  $('dictionary').checked = settings.dictionary;
  $('enabled').checked = settings.enabled;
  checkRadio('trigger', settings.trigger);
  checkRadio('theme', settings.theme);
  checkRadio('timeoutSeconds', settings.timeoutSeconds);
  checkRadio('uiLang', settings.uiLang);
  $('fontSize').value = settings.fontSize;
  $('fontSizeValue').textContent = `${settings.fontSize} px`;
  $('floatBall').checked = settings.floatBall;
  checkRadio('pageStyle', settings.pageStyle);
  renderBallHint();
  $('tryKbd').textContent = isMac ? '⌘ ↵' : 'Ctrl ↵';
  renderShortcuts();

  $('baseUrl').addEventListener('input', () => {
    renderPresets();
    saveBaseUrl();
    queueDetect();
  });
  $('apiKey').addEventListener('input', () => {
    saveApiKey();
    queueDetect();
  });
  $('toggleKey').addEventListener('click', () => {
    const input = $('apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  for (const radio of document.querySelectorAll('input[name="type"]')) {
    radio.addEventListener('change', () => {
      save({ provider: { type: radio.value } }, { quiet: true });
      runDetect();
    });
  }
  $('detect').addEventListener('click', () => runDetect());
  wireCombo();

  $('targetLang').addEventListener('change', (e) => save({ targetLang: e.target.value }));
  $('secondLang').addEventListener('change', (e) => save({ secondLang: e.target.value }));
  $('dictionary').addEventListener('change', (e) => save({ dictionary: e.target.checked }));
  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  for (const radio of document.querySelectorAll('input[name="trigger"]')) {
    radio.addEventListener('change', () => save({ trigger: radio.value }));
  }
  for (const radio of document.querySelectorAll('input[name="uiLang"]')) {
    radio.addEventListener('change', () => {
      save({ uiLang: radio.value }, { quiet: true });
      applyLocale(radio.value);
    });
  }
  for (const radio of document.querySelectorAll('input[name="timeoutSeconds"]')) {
    radio.addEventListener('change', () => save({ timeoutSeconds: Number(radio.value) }));
  }
  for (const radio of document.querySelectorAll('input[name="theme"]')) {
    radio.addEventListener('change', () => {
      applyTheme(radio.value);
      save({ theme: radio.value });
    });
  }
  $('fontSize').addEventListener('input', (e) => {
    $('fontSizeValue').textContent = `${e.target.value} px`;
    saveFontSize();
  });
  $('editShortcut').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  $('editPageShortcut').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  $('floatBall').addEventListener('change', (e) => save({ floatBall: e.target.checked }));
  for (const radio of document.querySelectorAll('input[name="pageStyle"]')) {
    radio.addEventListener('change', () => save({ pageStyle: radio.value }));
  }

  wirePromptEditor();
  $('tryButton').addEventListener('click', runTry);
  $('tryInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      runTry();
    }
  });

  const renderQuick = initQuickToggles({ themeButton: $('themeToggle'), languageButton: $('langToggle'), getSettings: () => settings });

  // Keep in sync with changes made elsewhere (e.g. the popup).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings?.newValue) return;
    const next = changes.settings.newValue;
    settings = { ...settings, ...next };
    if (next.theme && next.theme !== document.querySelector('input[name="theme"]:checked')?.value) {
      checkRadio('theme', next.theme);
      applyTheme(next.theme);
    }
    // After a possible language switch below, so titles use the new language.
    queueMicrotask(renderQuick);
    // Tab markers reflect what is stored, which lands after a debounced save.
    renderPromptStatus();
    if (next.enabled !== $('enabled').checked) $('enabled').checked = next.enabled;
    if (next.targetLang !== $('targetLang').value) $('targetLang').value = next.targetLang;
    if (next.floatBall !== undefined && next.floatBall !== $('floatBall').checked) $('floatBall').checked = next.floatBall;
    if (next.uiLang && next.uiLang !== document.querySelector('input[name="uiLang"]:checked')?.value) {
      checkRadio('uiLang', next.uiLang);
      applyLocale(next.uiLang);
    }
  });

  // Re-check a configured endpoint whose detection is missing or stale.
  const normalized = normalizeBaseUrl(provider.baseUrl);
  if (normalized && provider.resolved?.from !== normalized) runDetect();
  else if (!provider.baseUrl) $('baseUrl').focus();
}

init();
