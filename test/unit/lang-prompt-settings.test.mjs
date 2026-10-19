import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSourceLanguage, guessLanguageByScript, languageLabel, resolveTargets } from '../../src/shared/lang.js';
import { buildSystemPrompt, clampInput, isDictionaryCandidate, MAX_INPUT_CHARS } from '../../src/shared/prompt.js';
import { effectiveProvider, isProviderReady, mergeSettings } from '../../src/shared/settings.js';

test('guessLanguageByScript', () => {
  assert.equal(guessLanguageByScript('今天天气很好'), 'zh');
  assert.equal(guessLanguageByScript('今日はいい天気'), 'ja');
  assert.equal(guessLanguageByScript('안녕하세요'), 'ko');
  assert.equal(guessLanguageByScript('Привет'), 'ru');
  assert.equal(guessLanguageByScript('Hello there'), 'latin');
  assert.equal(guessLanguageByScript('12345'), 'und');
});

test('detectSourceLanguage uses the detector only for Latin script', async () => {
  const detector = async () => ({ isReliable: true, languages: [{ language: 'fr', percentage: 99 }] });
  assert.equal(await detectSourceLanguage('Bonjour tout le monde', detector), 'fr');
  assert.equal(await detectSourceLanguage('你好', detector), 'zh');
  assert.equal(await detectSourceLanguage('word', async () => ({ isReliable: false, languages: [] })), 'en');
  assert.equal(await detectSourceLanguage('word', async () => Promise.reject(new Error('x'))), 'en');
});

test('resolveTargets swaps to the second language when source equals target', () => {
  assert.deepEqual(resolveTargets({ sourceLang: 'en', targetLang: 'zh-CN', secondLang: 'en' }), {
    target: 'zh-CN',
    fallback: 'en',
    swapped: false,
  });
  assert.deepEqual(resolveTargets({ sourceLang: 'zh', targetLang: 'zh-CN', secondLang: 'en' }), {
    target: 'en',
    fallback: 'zh-CN',
    swapped: true,
  });
  assert.equal(resolveTargets({ sourceLang: 'zh', targetLang: 'zh-CN', secondLang: 'en', forceTarget: true }).target, 'zh-CN');
  // A misconfigured second language equal to the target still yields a different language.
  assert.equal(resolveTargets({ sourceLang: 'en', targetLang: 'en', secondLang: 'en' }).target, 'zh-CN');
  assert.equal(languageLabel('zh'), '中文');
  assert.equal(languageLabel('zh-cn'), '简体中文');
  assert.equal(languageLabel('fr-CA'), '法语');
  assert.equal(languageLabel('und'), '自动检测');
});

test('isDictionaryCandidate', () => {
  assert.equal(isDictionaryCandidate('serendipity'), true);
  assert.equal(isDictionaryCandidate('take off'), true);
  assert.equal(isDictionaryCandidate("don't"), true);
  assert.equal(isDictionaryCandidate('This is a full sentence.'), false);
  assert.equal(isDictionaryCandidate('翻译'), false);
  assert.equal(isDictionaryCandidate('C++'), false);
});

test('buildSystemPrompt names both languages', () => {
  const p = buildSystemPrompt({ mode: 'translate', target: 'zh-CN', fallback: 'en' });
  assert.match(p, /into Simplified Chinese/);
  assert.match(p, /into English instead/);
  assert.match(buildSystemPrompt({ mode: 'dictionary', target: 'ja', fallback: 'en' }), /dictionary entry for it in Japanese/);
  assert.equal(clampInput('x'.repeat(MAX_INPUT_CHARS + 10)).length, MAX_INPUT_CHARS);
});

test('settings merge and effective provider', () => {
  const s = mergeSettings({ provider: { baseUrl: 'api.deepseek.com', model: 'deepseek-chat' }, theme: 'dark' });
  assert.equal(s.theme, 'dark');
  assert.equal(s.provider.type, 'auto');
  assert.equal(s.targetLang, 'zh-CN');
  assert.deepEqual(effectiveProvider(s.provider), {
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
  });
  assert.equal(isProviderReady(s), true);

  const resolved = mergeSettings({
    provider: {
      baseUrl: 'https://relay.example.com',
      model: 'claude-haiku-4-5',
      resolved: { from: 'https://relay.example.com', type: 'anthropic', baseUrl: 'https://relay.example.com/v1' },
    },
  });
  assert.equal(effectiveProvider(resolved.provider).type, 'anthropic');
  // A stale detection for a different URL is ignored.
  const stale = mergeSettings({ provider: { ...resolved.provider, baseUrl: 'https://other.example.com' } });
  assert.equal(effectiveProvider(stale.provider).baseUrl, 'https://other.example.com/v1');
  assert.equal(effectiveProvider(stale.provider).type, 'openai');
  assert.equal(isProviderReady(mergeSettings({})), false);
});
