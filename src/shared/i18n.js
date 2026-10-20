// Interface strings in Simplified Chinese and English. This file is loaded
// both as a classic content script and as a side-effect ES module (like
// languages.js), so it only publishes GLINT_I18N on globalThis.
//
// Keys are grouped by surface; {name} placeholders are filled from params.
(() => {
  const MESSAGES = {
    'zh-CN': {
      'lang.auto': '自动检测',
      'lang.zh': '中文',
    },
    en: {
      'lang.auto': 'Auto-detect',
      'lang.zh': 'Chinese',
    },
  };

  const LOCALES = Object.freeze(Object.keys(MESSAGES));

  // 'auto' follows the browser's UI language; anything Chinese gets the
  // Chinese interface, everything else English.
  function resolveLocale(preference, uiLanguage = '') {
    if (LOCALES.includes(preference)) return preference;
    return /^zh(\b|[-_])/i.test(String(uiLanguage)) ? 'zh-CN' : 'en';
  }

  function translate(locale, key, params) {
    const template = MESSAGES[locale]?.[key] ?? MESSAGES['zh-CN'][key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
  }

  globalThis.GLINT_I18N = Object.freeze({ LOCALES, MESSAGES, resolveLocale, translate });
})();
