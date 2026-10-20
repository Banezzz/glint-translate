// Renders the Chrome Web Store images into store/assets/:
//   store-icon-128.png (96×96 artwork with 16 px transparent padding), and per
//   locale screenshot-1..5.png (1280×800), promo-small.png (440×280),
//   promo-marquee.png (1400×560).
// The extension runs for real against a local stand-in for the model API.
// Run with: npm run store:assets
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { API_BASE, LOCALES, MODEL, POPUP_TEXT, startShowcase } from './showcase.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'store', 'assets');
const SIZE = { width: 1280, height: 800 };
const LOGO = `data:image/svg+xml;base64,${readFileSync(join(ROOT, 'icons', 'logo.svg')).toString('base64')}`;

const COPY = {
  zh_CN: {
    font: "-apple-system, 'PingFang SC', 'Hiragino Sans GB', sans-serif",
    name: 'Glint 划词翻译',
    tagline: '划词翻译 · 网页双语对照',
    model: '接入你自己的大模型',
    heading: '用你自己的大模型翻译',
    points: ['OpenAI / Claude 兼容接口，自动识别协议与模型', '提示词、主题、中英文界面都可以自定义', 'API Key 只保存在本机，只发给你配置的接口'],
  },
  en: {
    font: "-apple-system, 'Helvetica Neue', sans-serif",
    name: 'Glint Translate',
    tagline: 'Selection and bilingual page translation',
    model: 'Powered by your own LLM',
    heading: 'Translate with your own model',
    points: ['Any OpenAI / Claude compatible API, detected automatically', 'Customize prompts, theme and interface language', 'Your API key stays on this device and goes only to your endpoint'],
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'glint-store-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: SIZE,
    deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  // A fresh install opens the settings page; close it.
  for (let waited = 0; waited < 5000 && !context.pages().some((p) => p.url().includes('/options/')); waited += 100) await sleep(100);
  await Promise.all(context.pages().filter((p) => p.url().includes('/options/')).map((p) => p.close()));
  return { context, worker, id, cleanup: () => rmSync(userDataDir, { recursive: true, force: true }) };
}

function settingsFor(locale, extra = {}) {
  const { uiLang, targetLang } = LOCALES[locale];
  return {
    uiLang,
    targetLang,
    theme: 'light',
    floatBall: true,
    ballDisabledSites: [],
    pageStyle: 'dashed',
    provider: { baseUrl: API_BASE, apiKey: '', model: MODEL, type: 'openai', models: [], resolved: null },
    ...extra,
  };
}

async function setSettings(worker, settings) {
  await worker.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);
}

async function sendPage(worker, url, message) {
  return worker.evaluate(
    async ({ url, message }) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.tabs.sendMessage(tab.id, { type: 'glint:page', ...message }, { frameId: 0 });
      return tab;
    },
    { url, message },
  );
}

async function openArticle(env, locale, colorScheme = 'light') {
  const page = await env.context.newPage();
  await page.emulateMedia({ colorScheme });
  const url = `${env.siteUrl}/${locale}.html`;
  await page.goto(url);
  await page.bringToFront();
  await page.locator('glint-ball .ball').waitFor();
  return { page, url };
}

async function translatePage(env, article, view = 'bilingual') {
  await sendPage(env.worker, article.url, { action: 'view', view });
  await article.page.locator('#p1 > glint-tr[data-glint-state="done"]').waitFor({ timeout: 10_000 });
  await article.page.waitForFunction(() => !document.querySelector('glint-tr[data-glint-state="loading"]'), null, { timeout: 10_000 });
  await article.page.locator('glint-ball .dock[data-state="active"]').waitFor({ timeout: 10_000 });
}

// Shows the ball's view switch, as when the pointer rests on the ball.
async function hoverBall(page) {
  await page.locator('glint-ball .ball').hover();
  await sleep(300);
}

async function clickTrigger(page) {
  const trigger = page.locator('glint-translate .trigger');
  await trigger.waitFor({ state: 'visible', timeout: 5000 });
  await trigger.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const box = await trigger.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function shot(page, locale, name, options = {}) {
  await page.screenshot({ path: join(OUT, locale, `${name}.png`), animations: 'disabled', ...options });
}

async function popupImage(env, locale, tab) {
  const popup = await env.context.newPage();
  await popup.setViewportSize({ width: 368, height: 600 });
  // The popup asks for the active tab; point it at the article.
  await popup.addInitScript((t) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (info) => (info?.active ? Promise.resolve([t]) : query(info));
  }, tab);
  await popup.goto(`chrome-extension://${env.id}/src/popup/popup.html`);
  await popup.locator('input[name="pageView"][value="bilingual"]:checked').waitFor({ timeout: 5000 });
  await popup.fill('#input', POPUP_TEXT[locale]);
  await popup.click('#translateButton');
  await popup.locator('#copy:visible').waitFor({ timeout: 8000 });
  const image = await popup.screenshot({ fullPage: true, animations: 'disabled', scale: 'device' });
  await popup.close();
  return image;
}

async function optionsImage(env) {
  const page = await env.context.newPage();
  await page.goto(`chrome-extension://${env.id}/src/options/options.html`);
  await page.click('#detect');
  await page.locator('#connection[data-state="ok"]').waitFor({ timeout: 8000 });
  const image = await page.locator('.panel').first().screenshot({ animations: 'disabled' });
  await page.close();
  return image;
}

const dataUrl = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;

async function renderHtml(context, html, size, path) {
  const page = await context.newPage();
  await page.setViewportSize(size);
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path, animations: 'disabled' });
  await page.close();
}

const BRAND_BG = 'radial-gradient(120% 140% at 0% 0%, #eef0ff 0%, #f5efff 45%, #fdf7ff 100%)';

function composeSetup(locale, options, popup) {
  const c = COPY[locale];
  return `<!doctype html><html><body style="margin:0;width:1280px;height:800px;overflow:hidden;background:${BRAND_BG};font-family:${c.font};color:#1f2328">
  <div style="position:absolute;left:72px;top:96px;width:420px">
    <img src="${LOGO}" width="56" height="56" style="border-radius:14px;box-shadow:0 10px 30px -10px rgba(99,102,241,.6)">
    <h1 style="margin:28px 0 26px;font-size:38px;line-height:1.2;letter-spacing:-.02em">${c.heading}</h1>
    ${c.points.map((p) => `<div style="display:flex;gap:12px;margin:0 0 18px;font-size:18px;line-height:1.5;color:#424a53"><span style="flex:none;width:8px;height:8px;margin-top:10px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#a855f7)"></span>${p}</div>`).join('')}
  </div>
  <img src="${dataUrl(options)}" style="position:absolute;left:520px;top:70px;width:600px;border-radius:16px;box-shadow:0 24px 60px -20px rgba(30,27,75,.35)">
  <img src="${dataUrl(popup)}" style="position:absolute;left:930px;top:250px;width:300px;border-radius:14px;box-shadow:0 30px 70px -18px rgba(30,27,75,.5);border:1px solid rgba(15,23,42,.08)">
</body></html>`;
}

function composeSmallTile(locale) {
  const c = COPY[locale];
  return `<!doctype html><html><body style="margin:0;width:440px;height:280px;overflow:hidden;background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 55%,#a855f7 100%);font-family:${c.font};color:#fff">
  <div style="position:absolute;inset:0;background:radial-gradient(60% 80% at 100% 0%,rgba(255,255,255,.22),transparent 60%)"></div>
  <div style="position:absolute;left:36px;top:44px;display:flex;align-items:center;gap:14px">
    <img src="${LOGO}" width="58" height="58" style="border-radius:15px;box-shadow:0 8px 24px -8px rgba(0,0,0,.4)">
    <div style="font-size:30px;font-weight:750;letter-spacing:-.01em">${c.name}</div>
  </div>
  <div style="position:absolute;left:36px;right:36px;top:140px;font-size:21px;font-weight:600;line-height:1.35">${c.tagline}</div>
  <div style="position:absolute;left:36px;top:200px;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.18);font-size:14px;font-weight:600">${c.model}</div>
</body></html>`;
}

function composeMarquee(locale, screenshot) {
  const c = COPY[locale];
  return `<!doctype html><html><body style="margin:0;width:1400px;height:560px;overflow:hidden;background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 55%,#a855f7 100%);font-family:${c.font};color:#fff">
  <div style="position:absolute;inset:0;background:radial-gradient(50% 90% at 0% 0%,rgba(255,255,255,.2),transparent 60%)"></div>
  <div style="position:absolute;left:80px;top:150px;width:470px">
    <div style="display:flex;align-items:center;gap:18px">
      <img src="${LOGO}" width="76" height="76" style="border-radius:20px;box-shadow:0 10px 30px -10px rgba(0,0,0,.45)">
      <div style="font-size:42px;font-weight:750;letter-spacing:-.015em">${c.name}</div>
    </div>
    <div style="margin-top:30px;font-size:28px;font-weight:600;line-height:1.35">${c.tagline}</div>
    <div style="display:inline-block;margin-top:22px;padding:8px 16px;border-radius:999px;background:rgba(255,255,255,.18);font-size:18px;font-weight:600">${c.model}</div>
  </div>
  <img src="${dataUrl(screenshot)}" style="position:absolute;left:620px;top:60px;width:820px;border-radius:14px;box-shadow:0 30px 80px -20px rgba(0,0,0,.5)">
</body></html>`;
}

async function renderStoreIcon(context) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 128, height: 128 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><img src="${LOGO}" width="96" height="96" style="display:block;margin:16px"></body></html>`, { waitUntil: 'load' });
  await page.screenshot({ path: join(OUT, 'store-icon-128.png'), omitBackground: true });
  await page.close();
}

async function renderLocale(env, locale) {
  mkdirSync(join(OUT, locale), { recursive: true });
  const { worker } = env;
  await setSettings(worker, settingsFor(locale));

  // 1. Bilingual page with the view switch on the ball.
  const article = await openArticle(env, locale);
  await translatePage(env, article);
  await hoverBall(article.page);
  await shot(article.page, locale, 'screenshot-1');
  const bilingual = await article.page.screenshot({ animations: 'disabled' });

  // 2. Translation only.
  await sendPage(worker, article.url, { action: 'view', view: 'translation' });
  await article.page.locator('#p1 > glint-tr[data-glint-view="translation"]').waitFor();
  await hoverBall(article.page);
  await shot(article.page, locale, 'screenshot-2');

  // 5 (rendered now, while the article tab is translated). Settings and popup.
  await sendPage(worker, article.url, { action: 'view', view: 'bilingual' });
  const tab = await sendPage(worker, article.url, { action: 'status' });
  const popup = await popupImage(env, locale, tab);
  const options = await optionsImage(env);
  await article.page.close();

  // 3. Selection card on the untranslated page.
  const plain = await openArticle(env, locale);
  await plain.page.locator('#p3').click({ clickCount: 3 });
  await clickTrigger(plain.page);
  await plain.page.locator('glint-translate .output:not(.streaming)').waitFor({ timeout: 8000 });
  await plain.page.mouse.move(640, 790);
  await shot(plain.page, locale, 'screenshot-3');
  await plain.page.close();

  // 4. Dark theme: bilingual page, plus a dictionary entry where there is an English word.
  await setSettings(worker, settingsFor(locale, { theme: 'dark' }));
  const dark = await openArticle(env, locale, 'dark');
  await translatePage(env, dark);
  if (locale === 'zh_CN') {
    await dark.page.locator('#word').dblclick();
    await clickTrigger(dark.page);
    await dark.page.locator('glint-translate .dict-example').waitFor({ timeout: 8000 });
    await dark.page.locator('glint-translate .caret').waitFor({ state: 'detached', timeout: 8000 });
    await dark.page.mouse.move(640, 790);
  } else {
    await hoverBall(dark.page);
  }
  await shot(dark.page, locale, 'screenshot-4');
  await dark.page.close();
  await setSettings(worker, settingsFor(locale));

  await renderHtml(env.context, composeSetup(locale, options, popup), SIZE, join(OUT, locale, 'screenshot-5.png'));
  await renderHtml(env.context, composeSmallTile(locale), { width: 440, height: 280 }, join(OUT, locale, 'promo-small.png'));
  await renderHtml(env.context, composeMarquee(locale, bilingual), { width: 1400, height: 560 }, join(OUT, locale, 'promo-marquee.png'));
  console.log(`✔ store/assets/${locale}`);
}

const showcase = await startShowcase();
const browser = await launch();
try {
  const env = { ...browser, siteUrl: showcase.siteUrl };
  mkdirSync(OUT, { recursive: true });
  await renderStoreIcon(browser.context);
  for (const locale of Object.keys(LOCALES)) await renderLocale(env, locale);
} finally {
  await browser.context.close();
  browser.cleanup();
  await showcase.close();
}
