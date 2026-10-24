import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSourceLanguage, guessLanguageByScript, languageLabel, resolveTargets } from '../../src/shared/lang.js';
import {
  buildPagePrompt,
  buildSystemPrompt,
  clampInput,
  DEFAULT_PROMPTS,
  isDictionaryCandidate,
  MAX_INPUT_CHARS,
  PROMPT_FORMATS,
  renderPrompt,
} from '../../src/shared/prompt.js';
import { effectiveProvider, isProviderReady, mergeSettings } from '../../src/shared/settings.js';
import '../../src/shared/dictionary.js';

const parseDictionary = globalThis.GLINT_PARSE_DICTIONARY;

test('guessLanguageByScript', () => {
  assert.equal(guessLanguageByScript('今天天气很好'), 'zh');
  assert.equal(guessLanguageByScript('今日はいい天気'), 'ja');
  assert.equal(guessLanguageByScript('안녕하세요'), 'ko');
  assert.equal(guessLanguageByScript('Привет'), 'ru');
  assert.equal(guessLanguageByScript('Hello there'), 'latin');
  assert.equal(guessLanguageByScript('12345'), 'und');
});

test('detectSourceLanguage counts Han per character and Latin per word', async () => {
  let calls = 0;
  const detector = async () => {
    calls += 1;
    return { isReliable: true, languages: [{ language: 'fr', percentage: 99 }] };
  };
  assert.equal(await detectSourceLanguage('Bonjour tout le monde', detector), 'fr');
  assert.equal(await detectSourceLanguage('你好', detector), 'zh');
  assert.equal(await detectSourceLanguage('今日はいい天気', detector), 'ja');
  assert.equal(await detectSourceLanguage('Привет', detector), 'ru');
  assert.equal(await detectSourceLanguage('12345', detector), 'und');
  assert.equal(await detectSourceLanguage('word', async () => ({ isReliable: false, languages: [] })), 'en');
  assert.equal(await detectSourceLanguage('word', async () => Promise.reject(new Error('x'))), 'en');
  // A Chinese sentence with a few English words stays Chinese, and the detector is not asked.
  const before = calls;
  for (const text of [
    '今天天气很好，我们去 park 散步吧',
    'Please 帮我看一下 this PR 的 changes',
    '这个函数 returns a Promise, 记得 await',
    'API 调用失败，请重试',
  ]) {
    assert.equal(await detectSourceLanguage(text, detector), 'zh', text);
  }
  assert.equal(calls, before);
  // Two English words tie one Han character; Latin wins and the detector may refine it.
  assert.equal(await detectSourceLanguage('Hello world 好', detector), 'fr');
  // A non-Latin detector answer cannot flip an English sentence.
  assert.equal(
    await detectSourceLanguage('Hello there', async () => ({ isReliable: true, languages: [{ language: 'zh-CN', percentage: 90 }] })),
    'en',
  );
});

test('resolveTargets sends Chinese to the second language', () => {
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
  assert.deepEqual(resolveTargets({ sourceLang: 'ja', targetLang: 'zh-CN', secondLang: 'en' }), {
    target: 'zh-CN',
    fallback: 'en',
    swapped: false,
  });
  // Not Chinese, so it stays even when source and target are the same language.
  assert.equal(resolveTargets({ sourceLang: 'ja', targetLang: 'ja', secondLang: 'en' }).target, 'ja');
  assert.equal(resolveTargets({ sourceLang: 'en', targetLang: 'en', secondLang: 'en' }).target, 'en');
  // A language picked on the card is kept, even for Chinese text.
  assert.equal(resolveTargets({ sourceLang: 'zh', targetLang: 'en', secondLang: 'ja', forceTarget: true }).target, 'en');
  assert.equal(resolveTargets({ sourceLang: 'zh', targetLang: 'zh-TW', secondLang: 'en', forceTarget: true }).target, 'zh-TW');
  // A Chinese second language is not a destination for Chinese text.
  assert.equal(resolveTargets({ sourceLang: 'zh', targetLang: 'zh-CN', secondLang: 'zh-TW' }).target, 'en');
  assert.equal(resolveTargets({ sourceLang: 'zh', targetLang: 'zh-CN', secondLang: 'ja' }).target, 'ja');
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

test('buildSystemPrompt names the target and does not ask the model to switch', () => {
  const p = buildSystemPrompt({ mode: 'translate', target: 'zh-CN', fallback: 'en' });
  assert.match(p, /into Simplified Chinese/);
  assert.doesNotMatch(p, /instead/);
  const dictionary = buildSystemPrompt({ mode: 'dictionary', target: 'ja', fallback: 'en' });
  assert.match(dictionary, /dictionary entry for it in Japanese/);
  assert.match(dictionary, /in English instead/);
  assert.equal(clampInput('x'.repeat(MAX_INPUT_CHARS + 10)).length, MAX_INPUT_CHARS);
});

test('custom prompt templates fill variables and keep the output format', () => {
  const custom = buildSystemPrompt({ mode: 'translate', target: 'zh-CN', fallback: 'en', source: 'fr', template: 'Translate {{from}} into {{to}} like a poet.' });
  assert.equal(custom, 'Translate French into Simplified Chinese like a poet.');
  // An unknown source drops the line that needs it.
  assert.equal(buildSystemPrompt({ mode: 'translate', target: 'ja', fallback: 'en', source: 'und', template: 'Source: {{from}}\nInto {{to}}.' }), 'Into Japanese.');
  // Parsers depend on the format, so it is appended to custom prompts too.
  const dictionary = buildSystemPrompt({ mode: 'dictionary', target: 'ja', fallback: 'en', template: 'Define it in {{to}}, kindly.' });
  assert.ok(dictionary.startsWith('Define it in Japanese, kindly.\n'));
  assert.ok(dictionary.endsWith(PROMPT_FORMATS.dictionary));
  const page = buildPagePrompt({ target: 'de', title: 'Docs', template: 'Technical docs titled {{title}}, into {{to}}.' });
  assert.equal(page, `Technical docs titled Docs, into German.\n${PROMPT_FORMATS.page}`);
  // A blank custom prompt means the default.
  assert.equal(buildSystemPrompt({ mode: 'translate', target: 'en', fallback: 'zh-CN', template: '  ' }), buildSystemPrompt({ mode: 'translate', target: 'en', fallback: 'zh-CN' }));
  assert.equal(renderPrompt('Keep {{unknown}} as is', { to: 'x' }), 'Keep {{unknown}} as is');
  assert.ok(DEFAULT_PROMPTS.translate.includes('{{to}}'));
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

test('settings keep every prompt mode when only some are customized', () => {
  const s = mergeSettings({ prompts: { page: 'Custom {{to}}' } });
  assert.deepEqual(s.prompts, { translate: '', dictionary: '', page: 'Custom {{to}}' });
  assert.equal(s.uiLang, 'auto');
});

test('parseDictionary reads the dictionary format, including partial input', () => {
  const entry = parseDictionary('/həˈloʊ/\nint. 你好；喂\nn. & v. 招呼\n\ne.g. Hello there! → 你好！\nextra note');
  assert.equal(entry.phonetic, '/həˈloʊ/');
  assert.deepEqual(entry.rows, [
    { kind: 'pos', pos: 'int.', text: '你好；喂' },
    { kind: 'pos', pos: 'n. & v.', text: '招呼' },
    { kind: 'example', text: 'Hello there! → 你好！' },
    { kind: 'text', text: 'extra note' },
  ]);
  // Mid-stream: an unfinished phonetic line is still treated as the phonetic.
  assert.deepEqual(parseDictionary('/həˈl'), { phonetic: '/həˈl', rows: [] });
  assert.deepEqual(parseDictionary(''), { phonetic: '', rows: [] });
});
