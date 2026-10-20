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

      'error.not_configured': '还没有配置模型服务',
      'error.not_configured.detail': '在设置页填写 API 地址、Key 并选择模型后即可使用',
      'error.empty': '没有可翻译的文本',
      'error.empty_response': '模型没有返回内容',
      'error.unknown': '翻译失败',
      'error.provider': '模型服务返回了错误',
      'error.bad_response': '无法解析模型服务的响应',
      'error.network': '无法连接到模型服务，请检查网络或 API 地址',
      'error.http_400': '请求被拒绝，请检查模型名称或参数',
      'error.http_401': 'API Key 无效或已过期',
      'error.http_402': '账户余额不足',
      'error.http_403': '没有访问权限',
      'error.http_404': '接口地址或模型不存在',
      'error.http_408': '请求超时',
      'error.http_413': '文本过长',
      'error.http_429': '请求过于频繁或额度不足',
      'error.http_5xx': '服务暂时不可用（HTTP {status}）',
      'error.http_other': '请求失败（HTTP {status}）',
    },
    en: {
      'lang.auto': 'Auto-detect',
      'lang.zh': 'Chinese',

      'error.not_configured': 'No model service set up yet',
      'error.not_configured.detail': 'Enter an API endpoint and key in Settings and pick a model to start translating',
      'error.empty': 'Nothing to translate',
      'error.empty_response': 'The model returned nothing',
      'error.unknown': 'Translation failed',
      'error.provider': 'The model service returned an error',
      'error.bad_response': "Could not read the model service's response",
      'error.network': 'Cannot reach the model service. Check your network or the API endpoint',
      'error.http_400': 'Request rejected. Check the model name or parameters',
      'error.http_401': 'Invalid or expired API key',
      'error.http_402': 'Insufficient account balance',
      'error.http_403': 'Access denied',
      'error.http_404': 'Endpoint or model not found',
      'error.http_408': 'Request timed out',
      'error.http_413': 'Text too long',
      'error.http_429': 'Too many requests or quota exceeded',
      'error.http_5xx': 'Service temporarily unavailable (HTTP {status})',
      'error.http_other': 'Request failed (HTTP {status})',
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

  // Title for an error code such as 'network' or 'http_404'.
  function errorText(locale, code, params) {
    let key = `error.${code}`;
    if (/^http_5\d\d$/.test(code)) key = 'error.http_5xx';
    else if (/^http_\d+$/.test(code) && !(key in MESSAGES['zh-CN'])) key = 'error.http_other';
    else if (!(key in MESSAGES['zh-CN'])) key = 'error.unknown';
    const status = /^http_(\d+)$/.exec(code)?.[1];
    return translate(locale, key, { status, ...params });
  }

  globalThis.GLINT_I18N = Object.freeze({ LOCALES, MESSAGES, resolveLocale, translate, errorText });
})();
