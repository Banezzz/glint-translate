import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../src/shared/i18n.js';
import { languageLabel } from '../../src/shared/lang.js';

const { LOCALES, MESSAGES, resolveLocale, translate } = globalThis.GLINT_I18N;

test('every key exists in every locale', () => {
  const [base, ...others] = LOCALES.map((locale) => Object.keys(MESSAGES[locale]).sort());
  for (const keys of others) assert.deepEqual(keys, base);
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(MESSAGES[locale])) assert.ok(value.trim(), `${locale} ${key} is empty`);
  }
});

test('placeholders match between locales', () => {
  const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(MESSAGES['zh-CN'])) {
    assert.deepEqual(names(MESSAGES.en[key]), names(MESSAGES['zh-CN'][key]), key);
  }
});

test('resolveLocale follows an explicit choice, else the browser language', () => {
  assert.equal(resolveLocale('en', 'zh-CN'), 'en');
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(resolveLocale('auto', 'zh-TW'), 'zh-CN');
  assert.equal(resolveLocale('auto', 'zh'), 'zh-CN');
  assert.equal(resolveLocale('auto', 'en-GB'), 'en');
  assert.equal(resolveLocale('auto', 'ja'), 'en');
  assert.equal(resolveLocale(undefined, ''), 'en');
});

test('translate fills placeholders and falls back to Chinese, then the key', () => {
  MESSAGES['zh-CN']['test.only'] = '共 {count} 个';
  try {
    assert.equal(translate('en', 'test.only', { count: 3 }), '共 3 个');
    assert.equal(translate('zh-CN', 'test.only'), '共 {count} 个');
  } finally {
    delete MESSAGES['zh-CN']['test.only'];
  }
  assert.equal(translate('en', 'missing.key'), 'missing.key');
});

test('language names follow the interface language', () => {
  assert.equal(languageLabel('zh-CN'), '简体中文');
  assert.equal(languageLabel('zh-CN', 'en'), 'Simplified Chinese');
  assert.equal(languageLabel('fr-CA', 'en'), 'French');
  assert.equal(languageLabel('zh', 'en'), 'Chinese');
  assert.equal(languageLabel('und', 'en'), 'Auto-detect');
  assert.equal(languageLabel('und'), '自动检测');
});
