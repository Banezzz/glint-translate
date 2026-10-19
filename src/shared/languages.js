// Shared language table. This file is loaded both as a classic content script
// and as a side-effect ES module, so it must not use import/export; it only
// publishes a frozen list on globalThis.
(() => {
  const LANGUAGES = [
    { code: 'zh-CN', label: '简体中文', english: 'Simplified Chinese', speech: 'zh-CN' },
    { code: 'zh-TW', label: '繁体中文', english: 'Traditional Chinese', speech: 'zh-TW' },
    { code: 'en', label: '英语', english: 'English', speech: 'en-US' },
    { code: 'ja', label: '日语', english: 'Japanese', speech: 'ja-JP' },
    { code: 'ko', label: '韩语', english: 'Korean', speech: 'ko-KR' },
    { code: 'fr', label: '法语', english: 'French', speech: 'fr-FR' },
    { code: 'de', label: '德语', english: 'German', speech: 'de-DE' },
    { code: 'es', label: '西班牙语', english: 'Spanish', speech: 'es-ES' },
    { code: 'pt', label: '葡萄牙语', english: 'Portuguese', speech: 'pt-BR' },
    { code: 'it', label: '意大利语', english: 'Italian', speech: 'it-IT' },
    { code: 'ru', label: '俄语', english: 'Russian', speech: 'ru-RU' },
    { code: 'ar', label: '阿拉伯语', english: 'Arabic', speech: 'ar-SA' },
    { code: 'vi', label: '越南语', english: 'Vietnamese', speech: 'vi-VN' },
    { code: 'th', label: '泰语', english: 'Thai', speech: 'th-TH' },
    { code: 'id', label: '印尼语', english: 'Indonesian', speech: 'id-ID' },
    { code: 'tr', label: '土耳其语', english: 'Turkish', speech: 'tr-TR' },
  ];
  globalThis.GLINT_LANGUAGES = Object.freeze(LANGUAGES.map((lang) => Object.freeze(lang)));
})();
