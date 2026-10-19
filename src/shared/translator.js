import { ANTHROPIC, authHeaders, errorMessage } from './providers.js';
import { createSSEParser } from './sse.js';

export class TranslationError extends Error {
  constructor(code, message, detail = '') {
    super(message);
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

const STATUS_MESSAGES = {
  400: '请求被拒绝，请检查模型名称或参数',
  401: 'API Key 无效或已过期',
  402: '账户余额不足',
  403: '没有访问权限',
  404: '接口地址或模型不存在',
  408: '请求超时',
  413: '文本过长',
  429: '请求过于频繁或额度不足',
};

export function httpErrorMessage(status) {
  if (STATUS_MESSAGES[status]) return STATUS_MESSAGES[status];
  if (status >= 500) return `服务暂时不可用（HTTP ${status}）`;
  return `请求失败（HTTP ${status}）`;
}

// Extracts a text delta (or terminal signal) from one parsed payload of
// either protocol. Both shapes are checked so a mislabeled endpoint still works.
export function readPayload(obj) {
  if (!obj || typeof obj !== 'object') return {};
  if (obj.type === 'error' || (obj.error && !obj.choices)) {
    return { error: errorMessage(obj) || '模型服务返回了错误' };
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

async function* rawDeltas(res) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const parser = createSSEParser();
  let mode = null; // 'sse' | 'json'
  let jsonText = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
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
            if (out.error) throw new TranslationError('provider', out.error);
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
        throw new TranslationError('bad_response', '无法解析模型服务的响应', jsonText.slice(0, 300));
      }
      const out = readPayload(obj);
      if (out.error) throw new TranslationError('provider', out.error);
      if (out.text) yield out.text;
    }
  } finally {
    // Stop downloading once the terminal event arrived or the consumer quit.
    await reader.cancel().catch(() => {});
  }
}

/**
 * Streams a completion and yields visible text deltas.
 * Throws TranslationError on HTTP or provider errors; AbortError propagates.
 */
export async function* streamChat({ request, fetchImpl = fetch, signal }) {
  let res;
  try {
    res = await fetchImpl(request.url, { ...request.init, signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new TranslationError('network', '无法连接到模型服务，请检查网络或 API 地址', String(err?.message || err));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 300);
    try {
      detail = errorMessage(JSON.parse(text)) || detail;
    } catch {
      // Keep the raw text.
    }
    throw new TranslationError(`http_${res.status}`, httpErrorMessage(res.status), detail);
  }
  if (!res.body) throw new TranslationError('bad_response', '模型服务没有返回内容');

  let full = '';
  let emitted = 0;
  for await (const delta of rawDeltas(res)) {
    full += delta;
    const visible = stripThinking(full);
    if (visible.length > emitted) {
      yield visible.slice(emitted);
      emitted = visible.length;
    }
  }
}
