import './languages.js';
import './i18n.js';

export const LANGUAGES = globalThis.GLINT_LANGUAGES;
const { translate } = globalThis.GLINT_I18N;

export function getLanguage(code) {
  if (!code) return null;
  const exact = LANGUAGES.find((lang) => lang.code.toLowerCase() === code.toLowerCase());
  if (exact) return exact;
  const primary = primarySubtag(code);
  return LANGUAGES.find((lang) => primarySubtag(lang.code) === primary) ?? null;
}

// Name of a language in the interface language ('zh-CN' or 'en').
export function languageLabel(code, locale = 'zh-CN') {
  if (!code || code === 'und') return translate(locale, 'lang.auto');
  // Detection only reports the macro language, not the script.
  if (code.toLowerCase() === 'zh') return translate(locale, 'lang.zh');
  const lang = getLanguage(code);
  if (!lang) return code;
  return locale === 'en' ? lang.english : lang.label;
}

export function primarySubtag(code) {
  return String(code || '').toLowerCase().split(/[-_]/)[0];
}

export function sameLanguage(a, b) {
  return Boolean(a && b) && primarySubtag(a) === primarySubtag(b);
}

const SCRIPT_PATTERNS = [
  ['ja', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
  ['ko', /\p{Script=Hangul}/gu],
  ['zh', /\p{Script=Han}/gu],
  ['ru', /\p{Script=Cyrillic}/gu],
  ['ar', /\p{Script=Arabic}/gu],
  ['th', /\p{Script=Thai}/gu],
  ['latin', /\p{Script=Latin}/gu],
];

// Cheap script-based guess. Returns 'latin' when the text is mostly Latin
// script, because the script alone cannot tell English from French.
export function guessLanguageByScript(text) {
  const counts = new Map();
  for (const [lang, re] of SCRIPT_PATTERNS) counts.set(lang, (String(text).match(re) || []).length);
  // Any kana means Japanese, even when most characters are Han.
  if (counts.get('ja') > 0) return 'ja';
  let best = 'und';
  let bestCount = 0;
  for (const [lang, count] of counts) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  return best;
}

// Han is counted per character and also credits Japanese, because kanji
// alone is ambiguous. Kana, hangul, Cyrillic, Arabic and Thai are per
// character too. Latin is counted per whitespace-separated word, so a
// Chinese sentence with a few English words stays Chinese. On a tie the
// earlier language wins, and 'en' is first: two English words and one
// character that is also credited to Japanese still come out English.
const WEIGHT_ORDER = ['en', 'zh', 'ko', 'th', 'ja', 'ru', 'ar'];

function languageWeights(text) {
  const weights = { en: 0, zh: 0, ko: 0, th: 0, ja: 0, ru: 0, ar: 0 };
  const input = String(text);
  for (const char of input) {
    if (/\p{Script=Han}/u.test(char)) {
      weights.zh += 1;
      weights.ja += 1;
    } else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)) {
      weights.ja += 1;
    } else if (/\p{Script=Hangul}/u.test(char)) {
      weights.ko += 1;
    } else if (/\p{Script=Thai}/u.test(char)) {
      weights.th += 1;
    } else if (/\p{Script=Cyrillic}/u.test(char)) {
      weights.ru += 1;
    } else if (/\p{Script=Arabic}/u.test(char)) {
      weights.ar += 1;
    }
  }
  // Pure Han was credited to both. One extra vote makes it Chinese.
  if (weights.zh > 0 && weights.zh === weights.ja) weights.zh += 1;
  for (const token of input.split(/\s+/)) {
    if (/[A-Za-z]/.test(token)) weights.en += 1;
  }
  return weights;
}

// 'latin' means the Latin words won and a detector may still distinguish
// English from French. 'und' means there were no letters at all.
function dominantLanguage(text) {
  const weights = languageWeights(text);
  let best = 'und';
  let bestCount = 0;
  for (const lang of WEIGHT_ORDER) {
    const count = weights[lang];
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  return best === 'en' ? 'latin' : best;
}

// detector: optional async (text) => { isReliable, languages: [{ language, percentage }] },
// i.e. chrome.i18n.detectLanguage. Consulted only after the word/character
// count says the text is Latin, and a non-Latin answer is ignored so a
// detector cannot flip an English sentence to Chinese.
export async function detectSourceLanguage(text, detector) {
  const dominant = dominantLanguage(text);
  if (dominant !== 'latin') return dominant;
  if (detector) {
    try {
      const result = await detector(text);
      const top = result?.languages?.[0]?.language;
      if (result?.isReliable && top && top !== 'und' && !['zh', 'ja', 'ko', 'ru', 'ar', 'th'].includes(primarySubtag(top))) return top;
    } catch {
      // Fall through to the heuristic default.
    }
  }
  return 'en';
}

// A second language that would not change the language, or a missing one,
// falls back to the other side of the Chinese/English pair.
function alternateLanguage(targetLang, secondLang) {
  if (secondLang && !sameLanguage(secondLang, targetLang)) return secondLang;
  return sameLanguage(targetLang, 'en') ? 'zh-CN' : 'en';
}

// Selection direction, decided here and not by the model. Detected Chinese
// goes to the second language (English by default, never another Chinese).
// Everything else goes to the configured target, even when that is the same
// language. An explicit target from the card is kept as chosen, including
// simplified-to-traditional, which detection cannot tell apart.
export function resolveTargets({ sourceLang, targetLang, secondLang, forceTarget = false }) {
  const second = alternateLanguage(targetLang, secondLang);
  if (forceTarget) return { target: targetLang, fallback: second, swapped: false };
  if (sameLanguage(sourceLang, 'zh')) {
    const chineseTarget = secondLang && !sameLanguage(secondLang, 'zh') ? secondLang : 'en';
    return { target: chineseTarget, fallback: targetLang, swapped: !sameLanguage(chineseTarget, targetLang) };
  }
  return { target: targetLang, fallback: second, swapped: false };
}
