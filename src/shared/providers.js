// Endpoint normalization, protocol auto-detection and model discovery for
// OpenAI-compatible and Anthropic-compatible APIs.

export const OPENAI = 'openai';
export const ANTHROPIC = 'anthropic';
export const ANTHROPIC_VERSION = '2023-06-01';

const ENDPOINT_SUFFIXES = ['/chat/completions', '/completions', '/messages', '/models', '/responses', '/embeddings'];
const VERSION_SEGMENT = /\/v\d+(?:\.\d+)?(?:alpha|beta)?\d*$/i;
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

// Turns whatever the user pasted ("api.openai.com", ".../v1/chat/completions",
// "http://localhost:11434/") into "scheme://host[/path]" without a trailing
// endpoint or slash. Returns '' for unusable input.
export function normalizeBaseUrl(input) {
  let raw = String(input ?? '').trim();
  if (!raw) return '';
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = (LOCAL_HOST.test(raw) ? 'http://' : 'https://') + raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  let path = url.pathname.replace(/\/+$/, '');
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of ENDPOINT_SUFFIXES) {
      if (path.toLowerCase().endsWith(suffix)) {
        path = path.slice(0, -suffix.length).replace(/\/+$/, '');
        stripped = true;
      }
    }
  }
  return url.origin + path;
}

// API roots worth probing, most likely first.
export function candidateBaseUrls(normalized) {
  if (!normalized) return [];
  const { pathname } = new URL(normalized);
  if (VERSION_SEGMENT.test(pathname) || /\/openai$/i.test(pathname)) return [normalized];
  if (pathname === '' || pathname === '/') return [`${normalized}/v1`, normalized];
  return [normalized, `${normalized}/v1`];
}

export function guessTypeFromUrl(url) {
  return /anthropic|claude/i.test(String(url)) ? ANTHROPIC : OPENAI;
}

export function authHeaders(type, apiKey) {
  if (type === ANTHROPIC) {
    return {
      'anthropic-version': ANTHROPIC_VERSION,
      // Required by api.anthropic.com for requests that carry an Origin header.
      'anthropic-dangerous-direct-browser-access': 'true',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    };
  }
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

// Which protocol an error body looks like, if any.
export function errorShape(body) {
  if (body && typeof body === 'object') {
    if (body.type === 'error' && body.error) return ANTHROPIC;
    if (body.error) return OPENAI;
  }
  return null;
}

export function errorMessage(body) {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 300) : '';
  const err = body.error;
  if (err && typeof err === 'object' && err.message) return String(err.message);
  if (typeof err === 'string') return err;
  return String(body.message || body.detail || body.msg || '');
}

// Accepts the model list shapes of OpenAI ({object:'list', data}),
// Anthropic ({data, has_more, first_id}) and a few loose variants.
export function parseModelList(body) {
  if (!body || typeof body !== 'object') return null;
  const items = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : null;
  if (!items) return null;
  const anthropicShape =
    items.some((m) => m && m.type === 'model') || (!Array.isArray(body) && 'has_more' in body && 'first_id' in body);
  const models = items
    .map((m) => {
      if (typeof m === 'string') return { id: m, name: '' };
      if (!m || typeof m !== 'object') return null;
      const id = String(m.id ?? m.model ?? m.name ?? '').trim();
      const name = String(m.display_name ?? (m.name && m.name !== id ? m.name : '') ?? '').trim();
      return id ? { id, name } : null;
    })
    .filter(Boolean);
  return { shape: anthropicShape ? ANTHROPIC : OPENAI, models };
}

const NON_CHAT_MODEL =
  /(embed|whisper|tts|dall-e|moderation|davinci|babbage|transcri|realtime|gpt-image|sora|rerank|-audio|computer-use|search-preview)/i;

// Dedupes, drops models that obviously cannot chat, and sorts OpenAI-style
// lists (Anthropic already returns newest first).
export function prepareModels(models, shape = OPENAI) {
  const seen = new Set();
  const unique = models.filter((m) => !seen.has(m.id) && seen.add(m.id));
  const chat = unique.filter((m) => !NON_CHAT_MODEL.test(m.id));
  const list = chat.length ? chat : unique;
  if (shape === OPENAI) list.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  return list;
}

// Fast, inexpensive models first: translation rarely needs a flagship.
const PREFERRED_MODELS = [
  /claude-.*haiku/i,
  /gpt-4\.1-mini/i,
  /gpt-4o-mini/i,
  /gpt-5.*-mini/i,
  /deepseek-(chat|v\d)/i,
  /gemini-[\d.]+-flash(?!.*(image|thinking|tts|live))/i,
  /qwen.*-(plus|turbo|flash)/i,
  /glm-4.*-(flash|air)/i,
  /claude-.*sonnet/i,
  /(mini|haiku|flash|lite|turbo)/i,
];

export function pickDefaultModel(models) {
  for (const re of PREFERRED_MODELS) {
    const hit = models.find((m) => re.test(m.id));
    if (hit) return hit.id;
  }
  return models[0]?.id ?? '';
}

// Keeps the current model when it is still meaningful: present in the fresh
// list, or a custom name the user typed. A stale pick from another
// endpoint's list is replaced by a sensible default.
export function chooseModel({ current, previousModels = [], models }) {
  const id = String(current || '').trim();
  if (id && models.some((m) => m.id === id)) return id;
  if (id && !previousModels.some((m) => m.id === id)) return id;
  return pickDefaultModel(models) || id;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function networkFailure(err) {
  const timedOut = err?.name === 'TimeoutError';
  return { network: true, timedOut, message: timedOut ? '' : String(err?.message || err) };
}

async function probeModels({ base, flavor, apiKey, fetchImpl, timeoutMs, signal }) {
  const started = Date.now();
  try {
    const res = await fetchImpl(`${base}/models`, {
      method: 'GET',
      headers: { accept: 'application/json', ...authHeaders(flavor, apiKey) },
      signal: withTimeout(signal, timeoutMs),
    });
    const body = await readJson(res);
    const latencyMs = Date.now() - started;
    const list = res.ok ? parseModelList(body) : null;
    return { base, flavor, status: res.status, latencyMs, list, shape: errorShape(body), message: errorMessage(body) };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { base, flavor, status: 0, latencyMs: Date.now() - started, ...networkFailure(err) };
  }
}

// Sends a deliberately empty request to the chat endpoint. A 400/422 with a
// JSON error proves the endpoint exists and accepted the key (servers check
// auth before validating the body); nothing is generated or billed.
async function probeChat({ base, flavor, apiKey, fetchImpl, timeoutMs, signal }) {
  const path = flavor === ANTHROPIC ? '/messages' : '/chat/completions';
  const started = Date.now();
  try {
    const res = await fetchImpl(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(flavor, apiKey) },
      body: '{}',
      signal: withTimeout(signal, timeoutMs),
    });
    const body = await readJson(res);
    return {
      base,
      flavor,
      status: res.status,
      latencyMs: Date.now() - started,
      shape: errorShape(body),
      message: errorMessage(body),
      exists: (res.status === 400 || res.status === 422) && typeof body === 'object',
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { base, flavor, status: 0, latencyMs: Date.now() - started, ...networkFailure(err) };
  }
}

function pickListResult(results, forced, hint) {
  const ok = results.filter((r) => r.list);
  if (!ok.length) return null;
  if (forced) return ok.find((r) => r.flavor === forced) ?? null;
  // A result counts as protocol X when it was requested as X and the body
  // also has X's shape; prefer the URL hint when both protocols answer.
  const consistent = ok.filter((r) => r.list.shape === r.flavor);
  const pool = consistent.length ? consistent : ok;
  const chosen = pool.find((r) => r.list.shape === hint) ?? pool[0];
  return { ...chosen, type: chosen.list.shape };
}

// Failures are described by code and params; the settings page words them.
function describeFailure(attempts) {
  const auth = attempts.find((a) => a.status === 401 || a.status === 403);
  if (auth) return { code: 'auth', params: { protocol: auth.shape || '' }, detail: auth.message };
  const rate = attempts.find((a) => a.status === 429);
  if (rate) return { code: 'rate_limit', params: {}, detail: rate.message };
  const server = attempts.find((a) => a.status >= 500);
  if (server) return { code: 'server', params: { status: server.status }, detail: server.message };
  if (attempts.length && attempts.every((a) => a.network)) {
    return { code: 'network', params: { timedOut: attempts.some((a) => a.timedOut) }, detail: attempts[0].message };
  }
  return { code: 'not_found', params: {}, detail: attempts.find((a) => a.message)?.message || '' };
}

/**
 * Detects which protocol an endpoint speaks and lists its models.
 * Resolves to { ok: true, type, baseUrl, models, latencyMs, warning }
 * (warning: '' | 'empty_models' | 'no_models')
 * or { ok: false, error: { code, params, detail } }.
 */
export async function detectEndpoint({ baseUrl, apiKey = '', type = 'auto', fetchImpl = fetch, timeoutMs = 10000, signal }) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return { ok: false, error: { code: 'invalid_url', params: {}, detail: '' } };
  const forced = type === OPENAI || type === ANTHROPIC ? type : null;
  const hint = forced ?? guessTypeFromUrl(normalized);
  const flavors = forced ? [forced] : hint === ANTHROPIC ? [ANTHROPIC, OPENAI] : [OPENAI, ANTHROPIC];
  const bases = candidateBaseUrls(normalized);
  const key = apiKey.trim();
  const ctx = { apiKey: key, fetchImpl, timeoutMs, signal };
  const attempts = [];

  for (const base of bases) {
    const results = await Promise.all(flavors.map((flavor) => probeModels({ ...ctx, base, flavor })));
    attempts.push(...results);
    const hit = pickListResult(results, forced, hint);
    if (hit) {
      const models = prepareModels(hit.list.models, hit.list.shape);
      return {
        ok: true,
        type: forced ?? hit.type,
        baseUrl: base,
        normalized,
        models,
        latencyMs: hit.latencyMs,
        warning: models.length ? '' : 'empty_models',
      };
    }
    // A network failure on the first candidate means the host is
    // unreachable; probing more paths would only add latency.
    if (results.every((r) => r.network)) break;
  }

  // No usable model list: confirm the protocol via the chat endpoint instead.
  if (!attempts.some((a) => a.status === 401 || a.status === 403) && !attempts.every((a) => a.network)) {
    for (const base of bases) {
      const results = await Promise.all(flavors.map((flavor) => probeChat({ ...ctx, base, flavor })));
      attempts.push(...results);
      const found = results.find((r) => r.exists && (forced || !r.shape || r.shape === r.flavor));
      if (found) {
        return {
          ok: true,
          type: forced ?? found.shape ?? found.flavor,
          baseUrl: base,
          normalized,
          models: [],
          latencyMs: found.latencyMs,
          warning: 'no_models',
        };
      }
    }
  }

  return { ok: false, error: describeFailure(attempts) };
}
