import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSSEParser } from '../../src/shared/sse.js';
import { buildChatRequest, stripThinking, streamChat, TranslationError } from '../../src/shared/translator.js';

test('SSE parser handles chunk boundaries, CRLF, comments and multi-line data', () => {
  const p = createSSEParser();
  const events = [
    ...p.push(': keep-alive\r\nevent: content_block_delta\r'),
    ...p.push('\ndata: {"a":'),
    ...p.push('1}\r\n\r\ndata: line1\ndata: line2\n\n'),
    ...p.push('data: tail'),
    ...p.flush(),
  ];
  assert.deepEqual(events, [
    { event: 'content_block_delta', data: '{"a":1}' },
    { event: 'message', data: 'line1\nline2' },
    { event: 'message', data: 'tail' },
  ]);
});

function streamResponse(chunks, { status = 200, contentType = 'text/event-stream' } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

async function collect(response, request = { url: 'https://x/v1/chat/completions', init: {} }) {
  let out = '';
  for await (const d of streamChat({ request, fetchImpl: async () => response })) out += d;
  return out;
}

const openaiChunk = (content) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;

test('streams OpenAI chat completion deltas until [DONE]', async () => {
  const res = streamResponse([openaiChunk('你好'), openaiChunk('，世界'), 'data: [DONE]\n\n', openaiChunk('ignored')]);
  assert.equal(await collect(res), '你好，世界');
});

test('streams Anthropic message deltas', async () => {
  const ev = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  const res = streamResponse([
    ev('message_start', { message: { id: 'm', content: [] } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('ping', {}),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' world' } }),
    ev('message_stop', {}),
  ]);
  assert.equal(await collect(res), 'Hello world');
});

test('accepts a non-streamed JSON body from either protocol', async () => {
  const openai = streamResponse([JSON.stringify({ choices: [{ message: { content: 'ok-openai' } }] })], { contentType: 'application/json' });
  assert.equal(await collect(openai), 'ok-openai');
  const anthropic = streamResponse([JSON.stringify({ content: [{ type: 'text', text: 'ok-claude' }] })], { contentType: 'application/json' });
  assert.equal(await collect(anthropic), 'ok-claude');
});

test('tolerates events that are missing the blank separator line', async () => {
  const res = streamResponse([`data: {"choices":[{"delta":{"content":"a"}}]}\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n`]);
  assert.equal(await collect(res), 'ab');
});

test('hides a leading <think> block', async () => {
  const res = streamResponse([openaiChunk('<thi'), openaiChunk('nk>reasoning'), openaiChunk('</think>\n\n'), openaiChunk('答案')]);
  assert.equal(await collect(res), '答案');
  assert.equal(stripThinking('plain <think> text'), 'plain <think> text');
  assert.equal(stripThinking('<'), '');
});

test('turns provider stream errors into TranslationError', async () => {
  const res = streamResponse([`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`]);
  await assert.rejects(collect(res), (err) => err instanceof TranslationError && err.code === 'provider' && err.detail === 'Overloaded');
});

test('maps HTTP failures to friendly messages with server detail', async () => {
  const res = new Response(JSON.stringify({ error: { message: 'The model `x` does not exist' } }), { status: 404 });
  await assert.rejects(collect(res), (err) => err.code === 'http_404' && /does not exist/.test(err.detail));
});

test('maps network failures', async () => {
  const request = { url: 'https://x', init: {} };
  const gen = streamChat({
    request,
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(gen.next(), (err) => err.code === 'network');
});

test('buildChatRequest targets the right endpoint per protocol', () => {
  const common = { baseUrl: 'https://h/v1', apiKey: 'k', model: 'm', system: 'S', text: 'T' };
  const a = buildChatRequest({ ...common, type: 'anthropic' });
  assert.equal(a.url, 'https://h/v1/messages');
  assert.equal(a.init.headers['x-api-key'], 'k');
  assert.deepEqual(JSON.parse(a.init.body), { model: 'm', max_tokens: 2048, system: 'S', messages: [{ role: 'user', content: 'T' }], stream: true });

  const o = buildChatRequest({ ...common, type: 'openai' });
  assert.equal(o.url, 'https://h/v1/chat/completions');
  assert.equal(o.init.headers.Authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(o.init.body).messages, [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'T' },
  ]);
});

// A body that sends the given chunks with a pause before each, then stays
// open forever when hang is true.
function slowBody(chunks, { gapMs = 0, hang = false } = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        controller.enqueue(encoder.encode(chunk));
      }
      if (!hang) controller.close();
    },
  });
}

const sse = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const request = { url: 'https://x/v1/chat/completions', init: {} };

async function drain(options) {
  let out = '';
  for await (const d of streamChat({ request, ...options })) out += d;
  return out;
}

test('times out when the server never answers', async () => {
  const fetchImpl = () => new Promise(() => {});
  const started = Date.now();
  await assert.rejects(drain({ fetchImpl, timeoutMs: 80 }), (err) => err instanceof TranslationError && err.code === 'timeout');
  assert.ok(Date.now() - started < 1000);
});

test('times out when a stream stops midway', async () => {
  const fetchImpl = async () => new Response(slowBody([sse('Hel'), sse('lo')], { hang: true }), { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(drain({ fetchImpl, timeoutMs: 80 }), (err) => err.code === 'timeout' && /No data/.test(err.detail));
});

test('a slow but steady stream does not time out', async () => {
  // Reasoning chunks carry no visible text but still count as activity.
  const thinking = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '…' } }] })}\n\n`;
  const chunks = [thinking, thinking, thinking, sse('Hel'), sse('lo'), 'data: [DONE]\n\n'];
  const fetchImpl = async () => new Response(slowBody(chunks, { gapMs: 50 }), { headers: { 'content-type': 'text/event-stream' } });
  assert.equal(await drain({ fetchImpl, timeoutMs: 120 }), 'Hello');
});

test('cancelling is not reported as a timeout', async () => {
  const controller = new AbortController();
  const fetchImpl = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(drain({ fetchImpl, signal: controller.signal, timeoutMs: 1000 }), (err) => !(err instanceof TranslationError));
});
