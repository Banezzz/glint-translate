// Demo content and a stand-in model API for the Chrome Web Store screenshots.
// The article exists in English and Chinese; the Chinese listing shows
// English → Chinese, the English listing Chinese → English.
import { createServer } from 'node:http';

// Screenshots show a local Ollama setup, so the stand-in listens on Ollama's
// port and nothing ever leaves the machine.
export const API_PORT = 11434;
export const API_BASE = `http://127.0.0.1:${API_PORT}/v1`;
export const MODEL = 'qwen2.5:7b';
const MODELS = ['qwen2.5:7b', 'llama3.1:8b', 'gemma2:9b', 'mistral:7b'];

// [English, Chinese] pairs, in page order.
const T = {
  home: ['Home', '首页'],
  essays: ['Essays', '随笔'],
  newsletter: ['Newsletter', '通讯'],
  about: ['About', '关于'],
  kicker: ['Essay · 8 min read', '随笔 · 阅读约 8 分钟'],
  title: ['The quiet art of reading in a second language', '用第二语言阅读的安静艺术'],
  lead: [
    'Reading in a language you are still learning is slow, and that slowness is not a flaw. It is where most of the learning happens.',
    '用一门仍在学习的语言阅读会很慢，但慢并不是缺点。大部分的学习，恰恰就发生在这里。',
  ],
  p1: [
    'When every sentence takes effort, you notice what a native reader skims past: the choice of a verb, the rhythm of a clause, the small words that carry a whole attitude.',
    '当每个句子都要费些力气，你会注意到母语读者一扫而过的东西：动词的选择、从句的节奏，还有那些承载着整个态度的小词。',
  ],
  p2: [
    'The trouble is losing the thread. Look up too many words and the argument dissolves; skip them and you are left guessing what the writer meant.',
    '麻烦在于容易读丢思路。查的词太多，论证就散了；跳过不查，又只能去猜作者的意思。',
  ],
  h2: ['Keep both languages in view', '让两种语言同时留在眼前'],
  p3: [
    'A side-by-side translation solves this without taking the original away. You read the source first, glance down when you get stuck, and carry on.',
    '对照翻译在不拿走原文的前提下解决了这个问题：先读原文，卡住时往下看一眼，然后接着读。',
  ],
  li1: ['Read each paragraph in the original first.', '每一段先读原文。'],
  li2: ['Check the translation only where you hesitate.', '只在犹豫的地方看译文。'],
  li3: ['Switch to translation only when you just need the gist.', '只想了解大意时，切换为仅译文。'],
  p4: [
    'Over time you will look down less often. That is the whole point: the translation is a handrail, not a replacement.',
    '久而久之，你往下看的次数会越来越少。这正是目的所在：译文是扶手，而不是替代品。',
  ],
  h2b: ['Further reading', '延伸阅读'],
  p5: [
    'Pick one article a week in the language you are learning, and read it twice: once with the translation, once without.',
    '每周挑一篇用你正在学的语言写的文章，读两遍：一遍对照译文，一遍不看译文。',
  ],
  popup: ['The translation is a handrail, not a replacement.', '译文是扶手，而不是替代品。'],
};

// The word double-clicked for the dictionary screenshot, inside p2.
export const DICTIONARY_WORD = 'thread';
const DICTIONARY = {
  thread: ['/θred/', 'n. 线；思路，脉络', 'v. 穿（针、线）；穿过', 'e.g. I lost the thread of the argument. → 我跟不上这个论证的思路了。'].join('\n'),
};

export const POPUP_TEXT = { zh_CN: T.popup[0], en: T.popup[1] };

// Each listing locale: interface language, target language and which side of
// the pairs is the source.
export const LOCALES = {
  zh_CN: { uiLang: 'zh-CN', targetLang: 'zh-CN', source: 0 },
  en: { uiLang: 'en', targetLang: 'en', source: 1 },
};

const normalize = (text) => String(text).replace(/\s+/g, ' ').trim();
const LOOKUP = new Map();
for (const [en, zh] of Object.values(T)) {
  LOOKUP.set(normalize(en), zh);
  LOOKUP.set(normalize(zh), en);
}

function translateText(text) {
  return LOOKUP.get(normalize(text)) ?? text;
}

function answer(system, user) {
  if (/dictionary/i.test(system)) return DICTIONARY[normalize(user).toLowerCase()] ?? translateText(user);
  if (/<seg id="N">/.test(system)) {
    return [...user.matchAll(/<seg id="(\d+)">([\s\S]*?)<\/seg>/g)].map(([, id, body]) => `<seg id="${id}">${translateText(body)}</seg>`).join('\n');
  }
  return translateText(user);
}

export function articleHtml(locale) {
  const s = (key) => T[key][LOCALES[locale].source];
  const p2 = locale === 'zh_CN' ? s('p2').replace(/\bthread\b/, `<span id="word">${DICTIONARY_WORD}</span>`) : s('p2');
  const lang = locale === 'zh_CN' ? 'en' : 'zh-CN';
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${s('title')} · The Reading Room</title>
<style>
  :root { color-scheme: light dark; --bg: #fbfaf7; --text: #1f2328; --muted: #59636e; --line: #e8e4dc; --accent: #9a5b13; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141417; --text: #e7e7ea; --muted: #a0a3ab; --line: #2a2a30; --accent: #e3a14f; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 18px/1.75 Charter, "Iowan Old Style", Georgia, "Songti SC", serif; }
  .site { display: flex; align-items: center; justify-content: space-between; max-width: 760px; margin: 0 auto; padding: 20px 24px; border-bottom: 1px solid var(--line); font: 15px/1.4 -apple-system, "PingFang SC", sans-serif; }
  .brand { font-weight: 700; letter-spacing: -0.01em; }
  nav { display: flex; gap: 22px; }
  nav a { color: var(--muted); text-decoration: none; }
  main { max-width: 700px; margin: 0 auto; padding: 30px 24px 600px; }
  .kicker { font: 600 13px/1.4 -apple-system, "PingFang SC", sans-serif; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent); }
  h1 { margin: 8px 0 14px; font: 700 38px/1.2 -apple-system, "PingFang SC", sans-serif; letter-spacing: -0.02em; }
  h2 { margin: 34px 0 6px; font: 700 23px/1.35 -apple-system, "PingFang SC", sans-serif; }
  .lead { font-size: 20px; color: var(--muted); }
  p { margin: 0 0 18px; }
  ul { padding-left: 1.2em; }
</style></head>
<body>
  <header class="site">
    <span class="brand" translate="no">The Reading Room</span>
    <nav><a href="#">${s('home')}</a><a href="#">${s('essays')}</a><a href="#">${s('newsletter')}</a><a href="#">${s('about')}</a></nav>
  </header>
  <main>
    <div class="kicker">${s('kicker')}</div>
    <h1 id="title">${s('title')}</h1>
    <p class="lead" id="lead">${s('lead')}</p>
    <p id="p1">${s('p1')}</p>
    <p id="p2">${p2}</p>
    <h2>${s('h2')}</h2>
    <p id="p3">${s('p3')}</p>
    <ul><li>${s('li1')}</li><li>${s('li2')}</li><li>${s('li3')}</li></ul>
    <p id="p4">${s('p4')}</p>
    <h2>${s('h2b')}</h2>
    <p id="p5">${s('p5')}</p>
  </main>
</body></html>`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleApi(req, res) {
  const url = new URL(req.url, API_BASE);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }
  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'library' })) }));
    return;
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const body = await readBody(req);
    const system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
    const user = body.messages?.findLast((m) => m.role === 'user')?.content ?? '';
    const text = answer(system, user);
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: text } }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...cors });
    for (let i = 0; i < text.length; i += 12) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(i, i + 12) } }] })}\n\n`);
      await sleep(4);
    }
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json', ...cors }).end('{"error":{"message":"not found"}}');
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Starts the model API on Ollama's port and an HTTP server for the article
// at /<locale>.html. Fails if a real Ollama is running; stop it first.
export async function startShowcase() {
  const api = createServer(handleApi);
  const site = createServer((req, res) => {
    const locale = /^\/(zh_CN|en)\.html$/.exec(req.url)?.[1];
    if (!locale) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(articleHtml(locale));
  });
  await listen(api, API_PORT);
  const sitePort = await listen(site);
  return {
    siteUrl: `http://127.0.0.1:${sitePort}`,
    close: () => Promise.all([api, site].map((server) => new Promise((resolve) => server.close(resolve)))),
  };
}
