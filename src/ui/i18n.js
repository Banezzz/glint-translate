// Interface language for extension pages (options, popup).
import '../shared/i18n.js';

const { errorText, resolveLocale, translate } = globalThis.GLINT_I18N;

let locale = resolveLocale('auto', chrome.i18n.getUILanguage());

// Takes the uiLang setting ('auto' | 'zh-CN' | 'en'); returns the locale used.
export function setLocale(preference) {
  locale = resolveLocale(preference, chrome.i18n.getUILanguage());
  document.documentElement.lang = locale;
  return locale;
}

export function getLocale() {
  return locale;
}

export function t(key, params) {
  return translate(locale, key, params);
}

export function errorTitle(code, params) {
  return errorText(locale, code, params);
}

export function protocolLabel(type) {
  return t(`protocol.${type}`);
}

// Fills static markup: data-i18n sets the text of a leaf element, and
// data-i18n-placeholder / -title / -aria-label set those attributes.
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
}
