// Local stand-in for OpenAI- and Anthropic-compatible APIs plus a test page.
//   /openai/v1/models, /openai/v1/chat/completions   (Bearer sk-openai-test)
//   /anthropic/v1/models, /anthropic/v1/messages      (x-api-key sk-ant-test)
//   /page.html                                        (content to select)
//   /article.html                                     (whole-page translation)
import { createServer } from 'node:http';

export const OPENAI_KEY = 'sk-openai-test';
export const ANTHROPIC_KEY = 'sk-ant-test';

export const PARAGRAPH =
  'Glint lets you translate any text on the web with the language model you already trust, without leaving the page.';
export const PARAGRAPH_ZH = 'Glint 让你无需离开页面，就能用自己信任的大模型翻译网页上的任何文字。';
export const WORD = 'serendipity';
export const DICTIONARY_ENTRY = [
  '/ˌserənˈdɪpəti/',
  'n. 意外发现珍奇事物的本领；机缘巧合',
  'e.g. Finding this café was pure serendipity. → 发现这家咖啡馆纯属机缘巧合。',
].join('\n');

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Glint test page</title>
<style>
  body { font: 17px/1.7 Georgia, serif; max-width: 680px; margin: 64px auto; padding: 0 24px; color: #222; }
  h1 { font: 700 30px/1.2 -apple-system, sans-serif; }
</style></head>
<body>
  <h1>Reading on the web</h1>
  <p id="para">${PARAGRAPH}</p>
  <p id="word-line">A happy accident is sometimes called <b id="word">${WORD}</b>.</p>
  <p id="zh">今天的天气非常好，适合出去散步。</p>
  <p><textarea id="field">Text inside a form field</textarea></p>
  <div style="height: 1200px"></div>
</body></html>`;

export const ARTICLE_PARAGRAPHS = [
  'Most of what we read online was written in a language we do not speak natively.',
  'Bilingual reading keeps the original next to the translation, so nothing is lost.',
  'Scroll down and the next paragraphs are translated just before they appear.',
];

export const ARTICLE_ZH = {
  'Reading in two languages': '用两种语言阅读',
  Home: '首页',
  Articles: '文章',
  'About us': '关于我们',
  [ARTICLE_PARAGRAPHS[0]]: '我们在网上读到的大部分内容，都不是用母语写成的。',
  [ARTICLE_PARAGRAPHS[1]]: '双语阅读让原文和译文并排出现，不会遗漏任何信息。',
  [ARTICLE_PARAGRAPHS[2]]: '向下滚动时，接下来的段落会在出现之前就翻译好。',
  'Keep the source text visible': '让 source 原文始终可见',
  'Translate only what you read': '只翻译你正在读的内容',
};

// Long enough that the last section starts below the fold.
const FILLER = Array.from({ length: 40 }, (_, i) => `<p class="filler">Filler paragraph number ${i + 1} keeps the page tall enough to scroll.</p>`).join('\n  ');

const ARTICLE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Reading in two languages</title>
<style>
  body { font: 17px/1.7 Georgia, serif; max-width: 680px; margin: 40px auto; padding: 0 24px; color: #222; }
  nav { display: flex; gap: 18px; font: 14px -apple-system, sans-serif; }
  nav a { color: #2563eb; text-decoration: none; }
  h1 { font: 700 30px/1.25 -apple-system, sans-serif; }
  pre { background: #f4f4f5; padding: 12px; }
  .hidden { display: none; }
</style></head>
<body>
  <nav><a href="#">Home</a><a href="#">Articles</a><a href="#">About us</a></nav>
  <h1 id="title">Reading in two languages</h1>
  <p id="p1">${ARTICLE_PARAGRAPHS[0]}</p>
  <p id="p2">${ARTICLE_PARAGRAPHS[1].replace('original', '<em>original</em>')}</p>
  <ul><li id="li1">Keep the <code>source</code> text visible</li><li id="li2">Translate only what you read</li></ul>
  <pre id="code">const answer = translate("do not touch");</pre>
  <p id="zh-para">这一段已经是中文了，不需要再翻译。</p>
  <p id="numbers">2025 · 42 · 3.14</p>
  <div class="hidden" id="hidden-menu"><p id="hidden-p">Hidden menu entry that appears later</p></div>
  ${FILLER}
  <p id="far">${ARTICLE_PARAGRAPHS[2]}</p>
</body></html>`;

// Whole-page batches come as <seg id="N">…</seg> lines.
function translateSegments(text) {
  const segments = [...text.matchAll(/<seg id="(\d+)">([\s\S]*?)<\/seg>/g)];
  return segments
    .map(([, id, body]) => {
      const filler = /^Filler paragraph number (\d+)/.exec(body);
      const translated = ARTICLE_ZH[body] ?? (filler ? `第 ${filler[1]} 段占位文字，让页面足够长、可以滚动。` : `【译】${body}`);
      return `<seg id="${id}">${translated}</seg>`;
    })
    .join('\n');
}

function cannedTranslation(text, system) {
  if (/dictionary/i.test(system)) return DICTIONARY_ENTRY;
  if (/<seg id="N">/.test(system)) return translateSegments(text);
  if (text === PARAGRAPH) return PARAGRAPH_ZH;
  if (/into English/.test(system.split('\n')[0])) return `[en] ${text}`;
  return `【译】${text}`;
}

function chunks(text) {
  return text.match(/[\s\S]{1,6}/g) ?? [];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function streamSse(res, events, delayMs) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) {
    res.write(event);
    await sleep(delayMs);
  }
  res.end();
}

export async function startMockServer({ delayMs = 12, port: listenPort = 0 } = {}) {
  const requests = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const body = req.method === 'POST' ? await readBody(req) : null;
    requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });

    if (url.pathname === '/page.html' || url.pathname === '/article.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(url.pathname === '/page.html' ? PAGE : ARTICLE);
      return;
    }

    // ---- OpenAI compatible
    if (url.pathname.startsWith('/openai/v1/')) {
      if (req.headers.authorization !== `Bearer ${OPENAI_KEY}`) {
        sendJson(res, 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } });
        return;
      }
      if (url.pathname === '/openai/v1/models') {
        sendJson(res, 200, {
          object: 'list',
          data: ['gpt-4o', 'gpt-4o-mini', 'text-embedding-3-small', 'whisper-1'].map((id) => ({ id, object: 'model', owned_by: 'mock' })),
        });
        return;
      }
      if (url.pathname === '/openai/v1/chat/completions' && req.method === 'POST') {
        if (!body?.model) {
          sendJson(res, 400, { error: { message: 'you must provide a model parameter', type: 'invalid_request_error' } });
          return;
        }
        const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
        const text = body.messages.find((m) => m.role === 'user')?.content ?? '';
        const events = chunks(cannedTranslation(text, system)).map(
          (content) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content } }] })}\n\n`,
        );
        await streamSse(res, [...events, 'data: [DONE]\n\n'], delayMs);
        return;
      }
    }

    // ---- Anthropic compatible
    if (url.pathname.startsWith('/anthropic/v1/')) {
      if (req.headers['x-api-key'] !== ANTHROPIC_KEY) {
        sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        return;
      }
      if (!req.headers['anthropic-version']) {
        sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'anthropic-version header is required' } });
        return;
      }
      if (url.pathname === '/anthropic/v1/models') {
        const data = [
          { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
          { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
        ].map((m) => ({ ...m, type: 'model', created_at: '2025-10-01T00:00:00Z' }));
        sendJson(res, 200, { data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id });
        return;
      }
      if (url.pathname === '/anthropic/v1/messages' && req.method === 'POST') {
        if (!body?.model) {
          sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'model: Field required' } });
          return;
        }
        const ev = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
        const text = body.messages[0].content;
        const events = [
          ev('message_start', { message: { id: 'msg', type: 'message', role: 'assistant', content: [], model: body.model } }),
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          ev('ping', {}),
          ...chunks(cannedTranslation(text, body.system ?? '')).map((t) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } })),
          ev('content_block_stop', { index: 0 }),
          ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }),
          ev('message_stop', {}),
        ];
        await streamSse(res, events, delayMs);
        return;
      }
    }

    sendJson(res, 404, { error: { message: `No route for ${req.method} ${url.pathname}` } });
  });

  await new Promise((resolve) => server.listen(listenPort, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// `node test/e2e/mock-server.mjs` keeps a server running for manual testing.
if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMockServer({ port: Number(process.env.PORT || 8787) });
  console.log(`mock API at ${mock.url}  ·  test page ${mock.url}/page.html`);
}
