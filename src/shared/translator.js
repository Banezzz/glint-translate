import { ANTHROPIC, authHeaders, errorMessage } from './providers.js';
import { createSSEParser } from './sse.js';

// Carries a code (e.g. 'network', 'http_404') rather than display text;
// consumers turn it into a message in the interface language.
export class TranslationError extends Error {
  constructor(code, detail = '') {
    super(code);
    this.name = 'TranslationError';
    this.code = code;
    this.detail = detail;
  }
}

export function buildChatRequest({ type, baseUrl, apiKey, model, system, text, stream = true, maxTokens = 2048 }) {
  const headers = { 'content-type': 'application/json', ...authHeaders(type, apiKey) };
  if (type === ANTHROPIC) {
    return {
      url: `${baseUrl}/messages`,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: text }], stream }),
      },
    };
  }
  return {
    url: `${baseUrl}/chat/completions`,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
        stream,
      }),
    },
  };
}

// Extracts a text delta (or terminal signal) from one parsed payload of
// either protocol. Both shapes are checked so a mislabeled endpoint still works.
export function readPayload(obj) {
  if (!obj || typeof obj !== 'object') return {};
  if (obj.type === 'error' || (obj.error && !obj.choices)) {
    return { error: errorMessage(obj) || '' };
  }
  // Anthropic
  if (obj.type === 'content_block_delta') return { text: obj.delta?.type === 'text_delta' ? obj.delta.text : '' };
  if (obj.type === 'message_stop') return { done: true };
  if (Array.isArray(obj.content)) {
    return { text: obj.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), done: true };
  }
  // OpenAI
  const choice = obj.choices?.[0];
  if (choice) {
    if (typeof choice.delta?.content === 'string') return { text: choice.delta.content };
    if (typeof choice.message?.content === 'string') return { text: choice.message.content, done: true };
    if (typeof choice.text === 'string') return { text: choice.text };
  }
  return {};
}

function parseEventData(data) {
  try {
    return [JSON.parse(data)];
  } catch {
    // Some servers omit the blank line between events, which merges several
    // JSON payloads into one multi-line event.
    return data
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
}

// Hides a leading <think>…</think> block some reasoning models emit inline.
export function stripThinking(full) {
  const lead = full.trimStart();
  if ('<think>'.startsWith(lead) && lead.length < 7) return '';
  if (!lead.startsWith('<think>')) return full;
  const end = lead.indexOf('</think>');
  return end === -1 ? '' : lead.slice(end + 8).trimStart();
}

// Rejects once the signal aborts, so a read on a stalled body cannot hang
// even when the body stream ignores the fetch signal.
function abortion(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

// onData runs for every chunk received, including ones that carry no text
// (reasoning tokens, keep-alive comments).
async function* rawDeltas(res, signal, onData) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const parser = createSSEParser();
  const aborted = abortion(signal);
  aborted.catch(() => {});
  let mode = null; // 'sse' | 'json'
  let jsonText = '';
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (!done) onData();
      const chunk = done ? '' : value;
      if (mode === null && chunk.trim()) mode = /^[[{]/.test(chunk.trimStart()) ? 'json' : 'sse';
      if (mode === 'json') {
        jsonText += chunk;
      } else {
        const events = done ? parser.flush() : parser.push(chunk);
        for (const event of events) {
          if (event.data.trim() === '[DONE]') return;
          for (const obj of parseEventData(event.data)) {
            const out = readPayload(obj);
            if (out.error !== undefined) throw new TranslationError('provider', out.error);
            if (out.text) yield out.text;
            if (out.done) return;
          }
        }
      }
      if (done) break;
    }
    if (mode === 'json') {
      let obj;
      try {
        obj = JSON.parse(jsonText);
      } catch {
        throw new TranslationError('bad_response', jsonText.slice(0, 300));
      }
      const out = readPayload(obj);
      if (out.error !== undefined) throw new TranslationError('provider', out.error);
      if (out.text) yield out.text;
    }
  } finally {
    // Stop downloading once the terminal event arrived or the consumer quit.
    await reader.cancel().catch(() => {});
  }
}

export const DEFAULT_TIMEOUT_SECONDS = 60;

/**
 * Streams a completion and yields visible text deltas.
 * Throws TranslationError on HTTP or provider errors; AbortError propagates.
 * timeoutMs bounds how long the server may stay silent: before the response
 * arrives, and between chunks of it. A slow but steady stream never times out.
 */
export async function* streamChat({ request, fetchImpl = fetch, signal, timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000 }) {
  const stall = new AbortController();
  let timer = 0;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(new DOMException('stalled', 'TimeoutError')), timeoutMs);
  };
  const combined = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;
  const timedOut = () => stall.signal.aborted && !signal?.aborted;
  const timeoutError = () => new TranslationError('timeout', `No data from the server for ${Math.round(timeoutMs / 1000)} s`);
  arm();
  try {
    yield* streamResponse({ request, fetchImpl, signal, combined, arm, timedOut, timeoutError });
  } finally {
    clearTimeout(timer);
  }
}

async function* streamResponse({ request, fetchImpl, signal, combined, arm, timedOut, timeoutError }) {
  let res;
  try {
    res = await Promise.race([fetchImpl(request.url, { ...request.init, signal: combined }), abortion(combined)]);
  } catch (err) {
    if (timedOut()) throw timeoutError();
    if (signal?.aborted) throw err;
    throw new TranslationError('network', String(err?.message || err));
  }
  arm();
  if (!res.ok) {
    const text = await Promise.race([res.text(), abortion(combined)]).catch(() => '');
    let detail = text.slice(0, 300);
    try {
      detail = errorMessage(JSON.parse(text)) || detail;
    } catch {
      // Keep the raw text.
    }
    throw new TranslationError(`http_${res.status}`, detail);
  }
  if (!res.body) throw new TranslationError('empty_response');

  let full = '';
  let emitted = 0;
  try {
    for await (const delta of rawDeltas(res, combined, arm)) {
      full += delta;
      const visible = stripThinking(full);
      if (visible.length > emitted) {
        yield visible.slice(emitted);
        emitted = visible.length;
      }
    }
  } catch (err) {
    if (timedOut()) throw timeoutError();
    throw err;
  }
}
