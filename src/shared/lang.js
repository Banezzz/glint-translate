import './languages.js';

export const LANGUAGES = globalThis.GLINT_LANGUAGES;

export function getLanguage(code) {
  if (!code) return null;
  const exact = LANGUAGES.find((lang) => lang.code.toLowerCase() === code.toLowerCase());
  if (exact) return exact;
  const primary = primarySubtag(code);
  return LANGUAGES.find((lang) => primarySubtag(lang.code) === primary) ?? null;
}

export function languageLabel(code) {
  if (!code || code === 'und') return '自动检测';
  // Detection only reports the macro language, not the script.
  if (code.toLowerCase() === 'zh') return '中文';
  return getLanguage(code)?.label ?? code;
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

// detector: optional async (text) => { isReliable, languages: [{ language, percentage }] },
// i.e. chrome.i18n.detectLanguage.
export async function detectSourceLanguage(text, detector) {
  const byScript = guessLanguageByScript(text);
  if (byScript !== 'latin') return byScript;
  if (detector) {
    try {
      const result = await detector(text);
      const top = result?.languages?.[0]?.language;
      if (result?.isReliable && top && top !== 'und') return top;
    } catch {
      // Fall through to the heuristic default.
    }
  }
  return 'en';
}

// When the source already is the target language, translate into the
// second language instead, unless the user explicitly forced a target.
export function resolveTargets({ sourceLang, targetLang, secondLang, forceTarget = false }) {
  const second = sameLanguage(secondLang, targetLang) ? (sameLanguage(targetLang, 'en') ? 'zh-CN' : 'en') : secondLang;
  if (!forceTarget && sameLanguage(sourceLang, targetLang)) {
    return { target: second, fallback: targetLang, swapped: true };
  }
  return { target: targetLang, fallback: second, swapped: false };
}
