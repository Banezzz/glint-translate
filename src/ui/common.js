// Helpers shared by extension pages (options, popup).
import '../shared/dictionary.js';
import { t } from './i18n.js';

const parseDictionary = globalThis.GLINT_PARSE_DICTIONARY;

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

let requestSeq = 0;

/**
 * Streams one translation through the background worker.
 * Returns a cancel function. Exactly one of onDone / onError fires.
 */
export function translateStream({ text, targetLang, fresh = false }, { onMeta, onDelta, onDone, onError }) {
  const port = chrome.runtime.connect({ name: 'glint:translate' });
  const id = `${Date.now()}-${++requestSeq}`;
  let finished = false;
  const finish = () => {
    finished = true;
    port.disconnect();
  };
  port.onMessage.addListener((message) => {
    if (message.id !== id || finished) return;
    if (message.type === 'meta') onMeta?.(message);
    else if (message.type === 'delta') onDelta?.(message.text);
    else if (message.type === 'done') {
      finish();
      onDone?.(message);
    } else if (message.type === 'error') {
      finish();
      onError?.(message);
    }
  });
  port.onDisconnect.addListener(() => {
    if (finished) return;
    finished = true;
    onError?.({ code: 'disconnected', message: t('error.disconnected'), detail: t('error.disconnected.detail') });
  });
  port.postMessage({ type: 'translate', id, text, targetLang, fresh });
  return () => {
    if (!finished) finish();
  };
}

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children.filter(Boolean));
  return node;
}

// Renders a (possibly still streaming) result: plain text, or a formatted
// dictionary entry when the worker answered in dictionary mode.
export function renderResult(target, { mode, text, source, streaming }) {
  const dictionary = mode === 'dictionary';
  target.classList.toggle('streaming', Boolean(streaming) && !dictionary);
  target.classList.toggle('is-dict', dictionary);
  if (!dictionary) {
    target.textContent = text;
    return;
  }
  const { phonetic, rows } = parseDictionary(text);
  target.replaceChildren(
    el('div', 'dict-head', el('span', 'dict-word', source), phonetic && el('span', 'dict-phonetic', phonetic)),
    ...rows.map((row) => {
      if (row.kind === 'example') return el('div', 'dict-example', row.text);
      return el('div', 'dict-row', row.kind === 'pos' && el('span', 'dict-pos', row.pos), el('span', 'dict-text', row.text));
    }),
  );
}

export function debounce(fn, ms) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.flush = (...args) => {
    clearTimeout(timer);
    return fn(...args);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

export function relativeTime(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return t('time.justNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('time.minutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('time.hours', { count: hours });
  return t('time.days', { count: Math.round(hours / 24) });
}
