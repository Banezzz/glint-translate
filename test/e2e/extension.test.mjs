// End-to-end tests: loads the unpacked extension into Chromium via Playwright
// and drives the options page, the in-page card and the popup against the
// local mock API. Screenshots land in .e2e-artifacts/ for visual review.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ANTHROPIC_KEY, ARTICLE_PARAGRAPHS, ARTICLE_ZH, OPENAI_KEY, PARAGRAPH, PARAGRAPH_ZH, startMockServer } from './mock-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACTS = join(ROOT, '.e2e-artifacts');
const HEADED = process.env.HEADED === '1';

let mock;
let context;
let extensionId;
let userDataDir;
let serviceWorker;

const shot = (page, name, options = {}) =>
  page.screenshot({ path: join(ARTIFACTS, `${name}.png`), animations: 'disabled', ...options });

before(async () => {
  mkdirSync(ARTIFACTS, { recursive: true });
  mock = await startMockServer();
  userDataDir = mkdtempSync(join(tmpdir(), 'glint-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !HEADED,
    viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  serviceWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(serviceWorker.url()).host;
  // A fresh install opens the settings page by itself. Wait for it and close
  // it, so it cannot take over a page a test is navigating to settings.
  const installed = (p) => p.url().startsWith(`chrome-extension://${extensionId}/src/options/`);
  for (let waited = 0; waited < 10_000 && !context.pages().some(installed); waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await Promise.all(context.pages().filter(installed).map((p) => p.close()));
  // The interface otherwise follows the browser language; tests assert Chinese text.
  await serviceWorker.evaluate(() => chrome.storage.local.set({ settings: { uiLang: 'zh-CN' } }));
});

after(async () => {
  await context?.close();
  await mock?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

// Waits for the trigger's pop-in animation, then clicks it like a user would.
// (Clicking mid-animation makes Playwright retry with forced scrolling.)
async function clickTrigger(page) {
  const trigger = page.locator('glint-translate .trigger');
  await trigger.waitFor({ state: 'visible', timeout: 5000 });
  await trigger.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const box = await trigger.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function openOptions() {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  return page;
}

async function setSettings(patch) {
  await serviceWorker.evaluate(async (p) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...p, provider: { ...settings.provider, ...(p.provider || {}) } } });
  }, patch);
}

test('options page auto-detects an Anthropic endpoint and its models', async () => {
  const page = await openOptions();
  await page.fill('#baseUrl', `${mock.url}/anthropic`);
  await page.fill('#apiKey', 'wrong-key');
  await assert.doesNotReject(page.locator('#connection[data-state="error"]').waitFor({ timeout: 8000 }));
  assert.match(await page.textContent('#connTitle'), /API Key 无效.*Anthropic/);
  await shot(page, 'options-error');

  await page.fill('#apiKey', ANTHROPIC_KEY);
  await page.locator('#connection[data-state="ok"]').waitFor({ timeout: 8000 });
  assert.match(await page.textContent('#connTitle'), /Anthropic 兼容 · 2 个模型/);
  assert.equal(await page.inputValue('#model'), 'claude-haiku-4-5');
  assert.match(await page.textContent('#connSub'), /\/anthropic\/v1/);
  await page.locator('.panel').first().screenshot({ path: join(ARTIFACTS, 'options-provider.png'), animations: 'disabled' });

  const modelsCall = mock.requests.findLast((r) => r.path === '/anthropic/v1/models' && r.headers['x-api-key'] === ANTHROPIC_KEY);
  assert.equal(modelsCall.headers['anthropic-version'], '2023-06-01');

  // The model picker lists what the endpoint returned.
  await page.click('#model');
  await page.locator('#modelList .combo-item').first().waitFor();
  assert.deepEqual(await page.locator('#modelList .combo-id').allTextContents(), ['claude-sonnet-4-5', 'claude-haiku-4-5']);
  await shot(page, 'options-anthropic', { fullPage: true });
  await page.keyboard.press('Escape');

  // Try it: streams a translation through the background worker.
  await page.fill('#tryInput', PARAGRAPH);
  await page.click('#tryButton');
  await page.locator('#tryOutput:not(.streaming)').waitFor({ timeout: 8000 });
  assert.equal(await page.textContent('#tryOutput'), PARAGRAPH_ZH);
  const call = mock.requests.findLast((r) => r.path === '/anthropic/v1/messages');
  assert.equal(call.body.model, 'claude-haiku-4-5');
  assert.equal(call.body.stream, true);
  assert.match(call.body.system, /Simplified Chinese/);
  await page.close();
});

test('options page switches to an OpenAI endpoint pasted as a full URL', async () => {
  const page = await openOptions();
  await page.fill('#baseUrl', `${mock.url}/openai/v1/chat/completions`);
  await page.fill('#apiKey', OPENAI_KEY);
  // Editing invalidates the previous (Anthropic) status immediately.
  assert.equal(await page.getAttribute('#connection', 'data-state'), 'checking');
  await page.locator('#connTitle', { hasText: 'OpenAI 兼容' }).waitFor({ timeout: 8000 });
  assert.equal(await page.getAttribute('#connection', 'data-state'), 'ok');
  assert.match(await page.textContent('#connTitle'), /OpenAI 兼容 · 2 个模型/);
  // The stale Claude pick is replaced; non-chat models are filtered out.
  assert.equal(await page.inputValue('#model'), 'gpt-4o-mini');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('.panel').first().screenshot({ path: join(ARTIFACTS, 'options-provider-dark.png'), animations: 'disabled' });

  const stored = await serviceWorker.evaluate(() => chrome.storage.local.get('settings'));
  assert.equal(stored.settings.provider.resolved.type, 'openai');
  assert.equal(stored.settings.provider.resolved.baseUrl, `${mock.url}/openai/v1`);
  await page.close();
});

test('the settings page switches its interface language live', async () => {
  const page = await openOptions();
  await page.locator('#connection[data-state="ok"]').waitFor({ timeout: 8000 });
  assert.equal(await page.textContent('h1'), 'Glint 划词翻译');
  assert.equal(await page.locator('input[name="timeoutSeconds"][value="60"]').isChecked(), true);
  await page.locator('input[name="uiLang"][value="en"]').check({ force: true });
  assert.equal(await page.textContent('h1'), 'Glint Translate');
  assert.equal(await page.locator('input[name="timeoutSeconds"][value="120"] + span').textContent(), '2 min');
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  assert.equal(await page.textContent('#sec-provider'), 'Model service');
  assert.match(await page.textContent('#connTitle'), /^Connected · OpenAI-compatible · 2 models$/);
  assert.equal(await page.locator('#targetLang option:checked').textContent(), 'Simplified Chinese');
  assert.equal(await page.getAttribute('#model', 'placeholder'), 'Pick from the list after detection, or type a model name');
  await page.locator('.panel').first().screenshot({ path: join(ARTIFACTS, 'options-provider-en.png'), animations: 'disabled' });
  const stored = await serviceWorker.evaluate(() => chrome.storage.local.get('settings'));
  assert.equal(stored.settings.uiLang, 'en');

  await page.locator('input[name="timeoutSeconds"][value="120"]').check({ force: true });
  await page.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.timeoutSeconds === 120);
  await page.locator('input[name="timeoutSeconds"][value="60"]').check({ force: true });

  // Another page switching back is picked up here too.
  await setSettings({ uiLang: 'zh-CN' });
  await page.locator('h1', { hasText: 'Glint 划词翻译' }).waitFor({ timeout: 3000 });
  assert.equal(await page.locator('input[name="uiLang"][value="zh-CN"]').isChecked(), true);
  await page.close();
});

test('selecting a paragraph shows the trigger and streams a translation card', async () => {
  await setSettings({ trigger: 'icon', theme: 'light' });
  const page = await context.newPage();
  await page.goto(`${mock.url}/page.html`);
  await page.locator('#para').click({ clickCount: 3 });

  await page.locator('glint-translate .trigger').waitFor({ state: 'visible', timeout: 5000 });
  await shot(page, 'page-trigger', { clip: { x: 0, y: 0, width: 1180, height: 420 } });
  await clickTrigger(page);

  const output = page.locator('glint-translate .output:not(.streaming)');
  await output.waitFor({ timeout: 8000 });
  assert.equal((await output.textContent()).trim(), PARAGRAPH_ZH);
  assert.equal(await page.locator('glint-translate .lang-source').textContent(), '英语');
  assert.equal(await page.locator('glint-translate .lang-target span').first().textContent(), '简体中文');
  assert.equal(await page.locator('glint-translate .model-name').textContent(), 'gpt-4o-mini');
  await shot(page, 'card-light', { clip: { x: 0, y: 0, width: 1180, height: 560 } });

  // Switching the target language re-translates with an explicit target.
  await page.locator('glint-translate .lang-target').click();
  await page.locator('glint-translate .lang-item', { hasText: '日语' }).click();
  await page.locator('glint-translate .output:not(.streaming)').waitFor({ timeout: 8000 });
  const call = mock.requests.findLast((r) => r.path === '/openai/v1/chat/completions');
  assert.match(call.body.messages[0].content, /into Japanese/);

  // Escape closes the card.
  await page.keyboard.press('Escape');
  await page.locator('glint-translate .card').waitFor({ state: 'hidden' });
  await page.close();
});

test('a single word gets a dictionary entry, in dark mode', async () => {
  await setSettings({ theme: 'dark' });
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${mock.url}/page.html`);
  await page.locator('#word').dblclick();
  await clickTrigger(page);
  await page.locator('glint-translate .dict-example').waitFor({ timeout: 8000 });
  await page.locator('glint-translate .caret').waitFor({ state: 'detached', timeout: 8000 });
  assert.equal(await page.locator('glint-translate .dict-word').textContent(), 'serendipity');
  assert.equal(await page.locator('glint-translate .dict-phonetic').textContent(), '/ˌserənˈdɪpəti/');
  assert.equal(await page.locator('glint-translate .dict-pos').first().textContent(), 'n.');
  assert.equal(await page.locator('glint-translate [data-theme="dark"]').count(), 1);
  await shot(page, 'card-dictionary-dark', { clip: { x: 0, y: 0, width: 1180, height: 560 } });
  await page.close();
  await setSettings({ theme: 'auto' });
});

test('Chinese text is translated into the second language', async () => {
  const page = await context.newPage();
  await page.goto(`${mock.url}/page.html`);
  await setSettings({ trigger: 'auto' });
  await page.locator('#zh').click({ clickCount: 3 });
  // 'auto' mode opens the card without the trigger.
  const output = page.locator('glint-translate .output:not(.streaming)');
  await output.waitFor({ timeout: 8000 });
  assert.match(await output.textContent(), /^\[en\] 今天的天气/);
  assert.equal(await page.locator('glint-translate .lang-source').textContent(), '中文');
  assert.equal(await page.locator('glint-translate .lang-target span').first().textContent(), '英语');
  await setSettings({ trigger: 'icon' });
  await page.close();
});

test('selections inside form fields do not trigger, and the site toggle works', async () => {
  const page = await context.newPage();
  await page.goto(`${mock.url}/page.html`);
  await page.locator('#field').click({ clickCount: 3 });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('glint-translate .trigger:visible').count(), 0);

  await setSettings({ disabledSites: ['127.0.0.1'] });
  await page.locator('#para').click({ clickCount: 3 });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('glint-translate .trigger:visible').count(), 0);
  await setSettings({ disabledSites: [] });
  await page.close();
});

test('context menu style requests open the card via the background worker', async () => {
  const page = await context.newPage();
  await page.goto(`${mock.url}/page.html`);
  await page.bringToFront();
  await serviceWorker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/page.html` });
    await chrome.tabs.sendMessage(tab.id, { type: 'glint:show', text: 'Hello from the menu' }, { frameId: 0 });
  }, mock.url);
  const output = page.locator('glint-translate .output:not(.streaming)');
  await output.waitFor({ timeout: 8000 });
  assert.equal((await output.textContent()).trim(), '【译】Hello from the menu');
  await page.keyboard.press('Escape');

  // The keyboard shortcut path translates the current selection.
  await page.locator('#zh').click({ clickCount: 3 });
  await serviceWorker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/page.html` });
    await chrome.tabs.sendMessage(tab.id, { type: 'glint:translate-selection' });
  }, mock.url);
  await page.locator('glint-translate .output:not(.streaming)', { hasText: '今天的天气' }).waitFor({ timeout: 8000 });
  await page.close();
});

// Clicks the floating ball like a user (it sits half off the right edge
// until hovered).
async function clickBall(page) {
  const ball = page.locator('glint-ball .ball');
  await ball.waitFor({ state: 'visible', timeout: 5000 });
  await ball.hover();
  await page.waitForTimeout(250);
  const box = await ball.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function chooseView(page, view) {
  await page.locator('glint-ball .ball').hover();
  const option = page.locator(`glint-ball .view[data-view="${view}"]`);
  await option.waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
  await option.click();
  await page.locator(`glint-ball .view[data-view="${view}"][aria-checked="true"]`).waitFor({ timeout: 3000 });
}

const translationOf = (page, id) => page.locator(`#${id} > glint-tr[data-glint-state="done"]`);

test('the floating ball translates the page bilingually, lazily and reversibly', async () => {
  await setSettings({ theme: 'light', pageStyle: 'dashed', floatBall: true, ballDisabledSites: [] });
  const page = await context.newPage();
  await page.goto(`${mock.url}/article.html`);
  const originalHtml = await page.locator('body').innerHTML();
  const before = mock.requests.length;
  await clickBall(page);

  // Visible paragraphs get their translation inserted right below them.
  await translationOf(page, 'p1').waitFor({ timeout: 8000 });
  assert.equal(await translationOf(page, 'p1').textContent(), ARTICLE_ZH[ARTICLE_PARAGRAPHS[0]]);
  // Inline markup is flattened into one sentence for the model.
  assert.equal(await translationOf(page, 'p2').textContent(), ARTICLE_ZH[ARTICLE_PARAGRAPHS[1]]);
  assert.equal(await translationOf(page, 'title').getAttribute('data-glint-mode'), 'block');
  // Inline code stays part of the sentence; short list items go inline.
  assert.equal(await translationOf(page, 'li1').textContent(), ARTICLE_ZH['Keep the source text visible']);
  assert.equal(await translationOf(page, 'li2').getAttribute('data-glint-mode'), 'block');
  // Navigation links are translated inline so menus keep their layout.
  const navTranslations = page.locator('nav glint-tr[data-glint-mode="inline"]');
  await assert.doesNotReject(navTranslations.nth(2).waitFor({ state: 'attached' }));
  // Code blocks, text already in the target language, bare numbers and
  // identifiers are left alone.
  assert.equal(await page.locator('#code glint-tr, #zh-para glint-tr, #numbers glint-tr, #ident glint-tr, #hidden-p glint-tr').count(), 0);
  // Below-the-fold content waits until it is scrolled to.
  assert.equal(await page.locator('#far glint-tr').count(), 0);
  await page.locator('glint-ball .dock[data-state="active"]').waitFor({ timeout: 8000 });
  await page.mouse.move(400, 300);
  await shot(page, 'page-bilingual', { clip: { x: 0, y: 0, width: 1180, height: 820 } });

  // Paragraphs travel in batches, not one request each.
  const batches = mock.requests.slice(before).filter((r) => r.path === '/openai/v1/chat/completions');
  assert.ok(batches.length >= 1 && batches.length <= 3, `expected few batched requests, got ${batches.length}`);
  assert.match(batches[0].body.messages[0].content, /web page into Simplified Chinese/);
  assert.match(batches[0].body.messages[1].content, /^<seg id="1">/);

  await page.locator('#far').scrollIntoViewIfNeeded();
  await translationOf(page, 'far').waitFor({ timeout: 8000 });
  assert.equal(await translationOf(page, 'far').textContent(), ARTICLE_ZH[ARTICLE_PARAGRAPHS[2]]);

  // Content added later and menus that become visible are picked up too.
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'added';
    p.textContent = 'This paragraph was loaded after the page was translated.';
    document.querySelector('#far').after(p);
    document.querySelector('#hidden-menu').classList.remove('hidden');
  });
  await translationOf(page, 'added').waitFor({ timeout: 8000 });
  await page.locator('#hidden-p').scrollIntoViewIfNeeded();
  await translationOf(page, 'hidden-p').waitFor({ timeout: 8000 });

  // Changing the style restyles existing translations in place.
  await setSettings({ pageStyle: 'highlight' });
  await page.locator('#p1 > glint-tr[data-glint-style="highlight"]').waitFor({ timeout: 3000 });

  // The hover switch shows the translation alone, in place of the source.
  await page.evaluate(() => scrollTo(0, 0));
  await chooseView(page, 'translation');
  const text = (id) => page.locator(`#${id}`).evaluate((el) => el.innerText.trim());
  assert.equal(await text('p1'), ARTICLE_ZH[ARTICLE_PARAGRAPHS[0]]);
  assert.equal(await text('p2'), ARTICLE_ZH[ARTICLE_PARAGRAPHS[1]]);
  assert.equal(await text('title'), ARTICLE_ZH['Reading in two languages']);
  assert.equal(await page.locator('nav').evaluate((el) => el.innerText.replace(/\s+/g, ' ').trim()), '首页 文章 关于我们');
  // Untranslated content is untouched; links stay links.
  assert.equal(await text('code'), 'const answer = translate("do not touch");');
  assert.equal(await text('zh-para'), '这一段已经是中文了，不需要再翻译。');
  assert.equal(await page.locator('nav a').first().evaluate((el) => el.innerText.trim()), '首页');
  assert.equal(await page.locator('glint-ball .view[aria-checked="true"]').textContent(), '译文');
  await page.mouse.move(400, 300);
  await shot(page, 'page-translation-only', { clip: { x: 0, y: 0, width: 1180, height: 820 } });

  // Back to bilingual: source and translation side by side again.
  await chooseView(page, 'bilingual');
  assert.equal(await text('p1'), `${ARTICLE_PARAGRAPHS[0]}\n${ARTICLE_ZH[ARTICLE_PARAGRAPHS[0]]}`);

  // Clicking the ball shows the original page, restored exactly.
  await clickBall(page);
  await page.locator('glint-ball .dock[data-state="idle"]').waitFor({ timeout: 3000 });
  assert.equal(await page.locator('glint-tr').count(), 0);

  // Translating again is served from cache without new requests.
  await page.evaluate(() => scrollTo(0, 0));
  const beforeAgain = mock.requests.length;
  await clickBall(page);
  await translationOf(page, 'p1').waitFor({ timeout: 8000 });
  assert.equal(mock.requests.slice(beforeAgain).filter((r) => r.path === '/openai/v1/chat/completions').length, 0);

  // After peeking at the original, the ball returns to the last translated view.
  await chooseView(page, 'translation');
  await clickBall(page);
  await page.locator('glint-ball .dock[data-state="idle"]').waitFor({ timeout: 3000 });
  await clickBall(page);
  await page.locator('#p1 > glint-tr[data-glint-view="translation"][data-glint-state="done"]').waitFor({ timeout: 8000 });
  assert.equal(await text('p1'), ARTICLE_ZH[ARTICLE_PARAGRAPHS[0]]);
  // Original view via the switch puts every node back as it was.
  await chooseView(page, 'original');
  await page.locator('glint-ball .dock[data-state="idle"]').waitFor({ timeout: 3000 });
  await page.locator('#added').evaluate((el) => el.remove());
  await page.locator('#hidden-menu').evaluate((el) => el.classList.add('hidden'));
  assert.equal(await page.locator('body').innerHTML(), originalHtml);
  await page.close();
  await setSettings({ pageStyle: 'dashed', theme: 'auto' });
});

test('page translation also runs from the menu/shortcut message, and the ball can be hidden per site', async () => {
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${mock.url}/article.html`);
  await page.bringToFront();
  const response = await serviceWorker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/article.html` });
    return chrome.tabs.sendMessage(tab.id, { type: 'glint:page', action: 'toggle' }, { frameId: 0 });
  }, mock.url);
  assert.equal(response.active, true);
  assert.equal(response.view, 'bilingual');
  await translationOf(page, 'p1').waitFor({ timeout: 8000 });
  // The popup switches views through the same message.
  const switched = await serviceWorker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/article.html` });
    return chrome.tabs.sendMessage(tab.id, { type: 'glint:page', action: 'view', view: 'translation' }, { frameId: 0 });
  }, mock.url);
  assert.equal(switched.view, 'translation');
  assert.equal(await page.locator('#p1').evaluate((el) => el.innerText.trim()), ARTICLE_ZH[ARTICLE_PARAGRAPHS[0]]);
  await page.locator('glint-ball .dock[data-state="active"]').waitFor({ timeout: 8000 });
  await page.locator('glint-ball .ball').hover();
  await page.waitForTimeout(250);
  await shot(page, 'ball-dark', { clip: { x: 780, y: 360, width: 400, height: 280 } });

  await page.locator('glint-ball .hide-btn').click();
  await page.locator('glint-ball').waitFor({ state: 'detached', timeout: 3000 });
  const stored = await serviceWorker.evaluate(() => chrome.storage.local.get('settings'));
  assert.deepEqual(stored.settings.ballDisabledSites, ['127.0.0.1']);
  // Hiding the ball does not undo the translation.
  assert.ok((await page.locator('glint-tr').count()) > 0);
  await setSettings({ ballDisabledSites: [] });
  await page.locator('glint-ball .ball').waitFor({ timeout: 3000 });
  await page.close();
});

test('page translation explains a missing configuration on the ball', async () => {
  const saved = await serviceWorker.evaluate(() => chrome.storage.local.get('settings'));
  await setSettings({ provider: { baseUrl: '', model: '', resolved: null } });
  const page = await context.newPage();
  await page.goto(`${mock.url}/article.html`);
  await clickBall(page);
  await page.locator('glint-ball .bubble').waitFor({ timeout: 5000 });
  assert.match(await page.locator('glint-ball .bubble-title').textContent(), /还没有配置模型服务/);
  assert.equal(await page.locator('glint-ball .chip-btn.primary').textContent(), '打开设置');
  await page.locator('#p1 > glint-tr[data-glint-state="error"]').waitFor({ timeout: 5000 });
  await page.close();
  await serviceWorker.evaluate((s) => chrome.storage.local.set(s), saved);
});

test('the card and the floating ball follow the interface language live', async () => {
  await setSettings({ uiLang: 'en', theme: 'light' });
  const page = await context.newPage();
  await page.goto(`${mock.url}/page.html`);
  await page.locator('#para').click({ clickCount: 3 });
  assert.equal(await page.locator('glint-translate .trigger').getAttribute('title'), 'Translate selection');
  await clickTrigger(page);
  await page.locator('glint-translate .output:not(.streaming)').waitFor({ timeout: 8000 });
  assert.equal(await page.locator('glint-translate .lang-source').textContent(), 'English');
  assert.equal(await page.locator('glint-translate .lang-target span').first().textContent(), 'Simplified Chinese');
  assert.equal(await page.locator('glint-translate .icon-btn[data-i18n-title="card.retranslate"]').getAttribute('title'), 'Translate again');
  assert.deepEqual(await page.locator('glint-ball .view').allTextContents(), ['Original', 'Bilingual', 'Translation']);
  assert.equal(await page.locator('glint-ball .ball').getAttribute('aria-label'), 'Translate this page');
  await shot(page, 'card-en', { clip: { x: 0, y: 0, width: 1180, height: 560 } });

  // The open card and the ball re-label themselves when the language changes.
  await setSettings({ uiLang: 'zh-CN' });
  await page.locator('glint-translate .lang-source', { hasText: '英语' }).waitFor({ timeout: 3000 });
  assert.equal(await page.locator('glint-translate .icon-btn[data-i18n-title="card.retranslate"]').getAttribute('title'), '重新翻译');
  assert.deepEqual(await page.locator('glint-ball .view').allTextContents(), ['原文', '双语', '译文']);
  assert.equal(await page.locator('glint-ball .ball').getAttribute('aria-label'), '翻译此网页');
  await page.close();
  await setSettings({ theme: 'auto' });
});

test('the theme and language toggles update every page at once', async () => {
  await setSettings({ theme: 'auto', uiLang: 'zh-CN' });
  const article = await context.newPage();
  await article.emulateMedia({ colorScheme: 'light' });
  await article.goto(`${mock.url}/article.html`);
  await article.locator('glint-ball .ball').waitFor();
  const options = await openOptions();
  await options.emulateMedia({ colorScheme: 'light' });
  const popup = await context.newPage();
  await popup.emulateMedia({ colorScheme: 'light' });
  await popup.setViewportSize({ width: 368, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.locator('#translate').waitFor();
  assert.equal(await popup.getAttribute('#themeToggle', 'title'), '主题：跟随系统（点击切换）');

  // System → light → dark.
  await popup.click('#themeToggle');
  await popup.locator('html[data-theme="light"]').waitFor({ timeout: 3000 });
  await popup.click('#themeToggle');
  await popup.locator('html[data-theme="dark"]').waitFor({ timeout: 3000 });
  assert.equal(await popup.getAttribute('#themeToggle', 'data-theme'), 'dark');
  await options.locator('html[data-theme="dark"]').waitFor({ timeout: 3000 });
  assert.equal(await options.locator('input[name="theme"][value="dark"]').isChecked(), true);
  await article.locator('glint-ball .ball-root[data-theme="dark"]').waitFor({ state: 'attached', timeout: 3000 });
  await shot(popup, 'popup-dark', { fullPage: true });

  // 中 → EN, everywhere.
  await popup.click('#langToggle');
  await popup.locator('#translateButton span', { hasText: 'Translate' }).waitFor({ timeout: 3000 });
  assert.equal(await popup.getAttribute('#langToggle span.on', 'data-locale'), 'en');
  assert.equal(await popup.getAttribute('#themeToggle', 'title'), 'Theme: Dark (click to change)');
  await options.locator('h1', { hasText: 'Glint Translate' }).waitFor({ timeout: 3000 });
  assert.equal(await options.getAttribute('#langToggle', 'title'), 'Language: English (click to change)');
  await article.locator('glint-ball .view', { hasText: 'Bilingual' }).waitFor({ timeout: 3000 });
  await options.locator('.hero').screenshot({ path: join(ARTIFACTS, 'options-hero-dark-en.png'), animations: 'disabled' });

  await popup.click('#langToggle');
  await options.locator('h1', { hasText: 'Glint 划词翻译' }).waitFor({ timeout: 3000 });
  await popup.click('#themeToggle');
  await article.locator('glint-ball .ball-root[data-theme="light"]').waitFor({ state: 'attached', timeout: 3000 });
  const stored = await serviceWorker.evaluate(() => chrome.storage.local.get('settings'));
  assert.equal(stored.settings.theme, 'auto');
  assert.equal(stored.settings.uiLang, 'zh-CN');
  await Promise.all([article.close(), options.close(), popup.close()]);
});

test('custom prompts are edited in settings and used for requests', async () => {
  const page = await openOptions();
  const badge = page.locator('#promptBadge');
  assert.match(await page.inputValue('#promptInput'), /^You are a professional translation engine\. Translate the user's text into \{\{to\}\}\./);
  assert.equal(await badge.textContent(), '默认');
  assert.equal(await page.locator('#promptReset').isDisabled(), true);
  assert.equal(await page.locator('#promptFormatWrap').isHidden(), true);

  // Edit the selection prompt, inserting a variable at the cursor.
  await page.fill('#promptInput', 'Translate into {{to}} like a pirate. Fallback: ');
  await page.locator('#promptInput').press('End');
  await page.locator('.var-chip[data-var="alt"]').click();
  assert.equal(await page.inputValue('#promptInput'), 'Translate into {{to}} like a pirate. Fallback: {{alt}}');
  assert.equal(await badge.textContent(), '已自定义');
  assert.equal(await page.locator('.prompt-tabs label.customized').count(), 1);

  // "Try it" sends the rendered custom prompt.
  await page.fill('#tryInput', 'Ahoy there, friend.');
  await page.click('#tryButton');
  await page.locator('#tryOutput', { hasText: '【译】Ahoy there, friend.' }).waitFor({ timeout: 8000 });
  const selection = mock.requests.findLast((r) => r.path === '/openai/v1/chat/completions');
  assert.equal(selection.body.messages[0].content, 'Translate into Simplified Chinese like a pirate. Fallback: English');
  const stored = await serviceWorker.evaluate(() => chrome.storage.local.get('settings'));
  assert.equal(stored.settings.prompts.translate, 'Translate into {{to}} like a pirate. Fallback: {{alt}}');

  // The page prompt keeps its fixed output format.
  await page.locator('input[name="promptMode"][value="page"]').check({ force: true });
  assert.match(await page.inputValue('#promptInput'), /\{\{title\}\}/);
  await page.locator('#promptFormatWrap summary').click();
  assert.match(await page.textContent('#promptFormat'), /<seg id="N">/);
  assert.deepEqual(await page.locator('.var-chip').evaluateAll((chips) => chips.map((c) => c.dataset.var)), ['to', 'title']);
  await page.fill('#promptInput', 'Pages titled {{title}} go into {{to}}, gently.');
  await page.locator('[aria-labelledby="sec-prompt"]').screenshot({ path: join(ARTIFACTS, 'options-prompts.png'), animations: 'disabled' });
  await page.locator('input[name="promptMode"][value="translate"]').check({ force: true });
  await page.waitForFunction(() => document.querySelectorAll('.prompt-tabs label.customized').length === 2);

  const article = await context.newPage();
  await article.goto(`${mock.url}/article.html`);
  await article.bringToFront();
  await serviceWorker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/article.html` });
    return chrome.tabs.sendMessage(tab.id, { type: 'glint:page', action: 'toggle' }, { frameId: 0 });
  }, mock.url);
  await translationOf(article, 'p1').waitFor({ timeout: 8000 });
  const batch = mock.requests.findLast((r) => r.path === '/openai/v1/chat/completions');
  assert.match(batch.body.messages[0].content, /^Pages titled Reading in two languages go into Simplified Chinese, gently\.\nThe user message contains segments wrapped as <seg id="N">/);
  await article.close();

  // Reset puts the default back and stores nothing.
  await page.bringToFront();
  await page.click('#promptReset');
  assert.equal(await badge.textContent(), '默认');
  await page.locator('input[name="promptMode"][value="page"]').check({ force: true });
  await page.click('#promptReset');
  await page.waitForFunction(() => !document.querySelector('.prompt-tabs label.customized'));
  const reset = await serviceWorker.evaluate(() => chrome.storage.local.get('settings'));
  assert.deepEqual(reset.settings.prompts, { translate: '', dictionary: '', page: '' });
  await page.close();
});

const chatRequests = (from) => mock.requests.slice(from).filter((r) => r.path === '/openai/v1/chat/completions');

async function togglePageFromWorker(page) {
  await page.bringToFront();
  return serviceWorker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/article.html` });
    return chrome.tabs.sendMessage(tab.id, { type: 'glint:page', action: 'toggle' }, { frameId: 0 });
  }, mock.url);
}

test('page translation retries a request the server never answers', async () => {
  // A prompt of its own keeps earlier cached translations out of the way.
  await setSettings({ timeoutSeconds: 1, prompts: { page: 'Stall test into {{to}}.' } });
  mock.faults.stall = 1;
  const page = await context.newPage();
  await page.goto(`${mock.url}/article.html`);
  const before = mock.requests.length;
  await togglePageFromWorker(page);
  await translationOf(page, 'p1').waitFor({ timeout: 10_000 });
  assert.equal(await translationOf(page, 'p1').textContent(), ARTICLE_ZH[ARTICLE_PARAGRAPHS[0]]);
  const first = chatRequests(before)[0].body.messages[1].content;
  assert.ok(chatRequests(before).filter((r) => r.body.messages[1].content === first).length >= 2, 'the stalled batch was sent again');
  assert.equal(await page.locator('glint-tr[data-glint-state="error"]').count(), 0);
  await page.close();
});

test('page translation reports a service that keeps stalling, after retrying', async () => {
  await setSettings({ timeoutSeconds: 1, prompts: { page: 'Give up test into {{to}}.' } });
  mock.faults.stall = 1000;
  const page = await context.newPage();
  await page.goto(`${mock.url}/article.html`);
  const before = mock.requests.length;
  await togglePageFromWorker(page);
  const failed = page.locator('#p1 > glint-tr[data-glint-state="error"]');
  await failed.waitFor({ timeout: 20_000 });
  assert.match(await failed.getAttribute('title'), /模型服务长时间没有响应/);
  assert.equal(await page.locator('glint-ball .bubble-title').textContent(), '模型服务长时间没有响应');
  // One request plus two retries for the first batch.
  const first = chatRequests(before)[0].body.messages[1].content;
  assert.equal(chatRequests(before).filter((r) => r.body.messages[1].content === first).length, 3);
  mock.faults.stall = 0;
  // Clicking the paragraph tries again, now successfully.
  await failed.click();
  await translationOf(page, 'p1').waitFor({ timeout: 10_000 });
  await page.close();
  await setSettings({ timeoutSeconds: 60, prompts: { page: '' } });
});

test('selection translation retries server errors before showing the result', async () => {
  mock.faults.fail = 2;
  const page = await context.newPage();
  await page.setViewportSize({ width: 368, height: 600 });
  await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  const before = mock.requests.length;
  await page.fill('#input', 'Busy servers deserve a second chance.');
  await page.click('#translateButton');
  await page.locator('#result', { hasText: '【译】Busy servers deserve a second chance.' }).waitFor({ timeout: 10_000 });
  assert.equal(chatRequests(before).length, 3);
  assert.equal(mock.faults.fail, 0);
  await page.close();
});

test('popup translates typed text and shows the provider status', async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 368, height: 600 });
  await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await page.locator('#translate').waitFor();
  assert.match(await page.textContent('#statusText'), /gpt-4o-mini · OpenAI 兼容/);
  await page.fill('#input', 'Good morning, how is everyone doing today?');
  await page.click('#translateButton');
  await page.locator('#copy:visible').waitFor({ timeout: 8000 });
  assert.equal(await page.textContent('#result'), '【译】Good morning, how is everyone doing today?');
  await shot(page, 'popup', { fullPage: true });

  // A single word is shown as a formatted dictionary entry.
  await page.fill('#input', 'serendipity');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await page.locator('#copy:visible').waitFor({ timeout: 8000 });
  assert.equal(await page.textContent('#result .dict-word'), 'serendipity');
  assert.equal(await page.textContent('#result .dict-pos'), 'n.');
  await shot(page, 'popup-dictionary', { fullPage: true });

  // Switching the interface language re-renders the open popup.
  await setSettings({ uiLang: 'en' });
  await page.locator('#translateButton span', { hasText: 'Translate' }).waitFor({ timeout: 3000 });
  assert.equal(await page.textContent('#statusText'), 'gpt-4o-mini · OpenAI-compatible');
  assert.equal(await page.textContent('#resultMeta'), 'English → Simplified Chinese');
  assert.equal(await page.locator('#targetLang option:checked').textContent(), 'Simplified Chinese');
  assert.equal(await page.getAttribute('#input', 'placeholder'), 'Type or paste text to translate');
  await shot(page, 'popup-en', { fullPage: true });
  await setSettings({ uiLang: 'zh-CN' });
  await page.close();
});

test('popup shows the setup state when nothing is configured', async () => {
  const saved = await serviceWorker.evaluate(() => chrome.storage.local.get('settings'));
  await serviceWorker.evaluate(() => chrome.storage.local.clear());
  await setSettings({ uiLang: 'zh-CN' });
  const page = await context.newPage();
  await page.setViewportSize({ width: 368, height: 520 });
  await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await page.locator('#setup').waitFor();
  assert.equal(await page.locator('#translate').isHidden(), true);
  await shot(page, 'popup-setup', { fullPage: true });
  await page.close();

  // The card explains what is missing instead of failing silently.
  const tab = await context.newPage();
  await tab.goto(`${mock.url}/page.html`);
  await tab.locator('#para').click({ clickCount: 3 });
  await clickTrigger(tab);
  await tab.locator('glint-translate .error').waitFor({ timeout: 5000 });
  assert.match(await tab.locator('glint-translate .error-title').textContent(), /还没有配置模型服务/);
  assert.equal(await tab.locator('glint-translate .lang-source').textContent(), '原文');
  assert.equal(await tab.locator('glint-translate .chip-btn.primary').textContent(), '打开设置');
  // Opening the card never scrolls the page.
  assert.equal(await tab.evaluate(() => scrollY), 0);
  await shot(tab, 'card-not-configured', { clip: { x: 0, y: 0, width: 1180, height: 480 } });
  await tab.close();
  await serviceWorker.evaluate((s) => chrome.storage.local.set(s), saved);
});
