import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateBaseUrls,
  chooseModel,
  detectEndpoint,
  normalizeBaseUrl,
  parseModelList,
  pickDefaultModel,
  prepareModels,
} from '../../src/shared/providers.js';

test('normalizeBaseUrl cleans up pasted URLs', () => {
  const cases = {
    'api.openai.com': 'https://api.openai.com',
    'https://api.openai.com/v1/': 'https://api.openai.com/v1',
    'https://api.openai.com/v1/chat/completions': 'https://api.openai.com/v1',
    'https://api.anthropic.com/v1/messages': 'https://api.anthropic.com/v1',
    'https://openrouter.ai/api/v1/models': 'https://openrouter.ai/api/v1',
    'localhost:11434': 'http://localhost:11434',
    '192.168.1.8:8000/v1': 'http://192.168.1.8:8000/v1',
    '  https://example.com/proxy//  ': 'https://example.com/proxy',
    'ftp://example.com': '',
    'not a url at all': '',
    '': '',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(normalizeBaseUrl(input), expected, input);
  }
});

test('candidateBaseUrls tries /v1 for bare hosts and keeps versioned paths', () => {
  assert.deepEqual(candidateBaseUrls('https://api.openai.com'), ['https://api.openai.com/v1', 'https://api.openai.com']);
  assert.deepEqual(candidateBaseUrls('https://open.bigmodel.cn/api/paas/v4'), ['https://open.bigmodel.cn/api/paas/v4']);
  assert.deepEqual(candidateBaseUrls('https://generativelanguage.googleapis.com/v1beta/openai'), [
    'https://generativelanguage.googleapis.com/v1beta/openai',
  ]);
  assert.deepEqual(candidateBaseUrls('https://openrouter.ai/api'), ['https://openrouter.ai/api', 'https://openrouter.ai/api/v1']);
  assert.deepEqual(candidateBaseUrls(''), []);
});

test('parseModelList recognizes both protocols by shape', () => {
  const openai = parseModelList({ object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model' }] });
  assert.equal(openai.shape, 'openai');
  assert.deepEqual(openai.models, [{ id: 'gpt-4o-mini', name: '' }]);

  const anthropic = parseModelList({
    data: [{ id: 'claude-haiku-4-5', type: 'model', display_name: 'Claude Haiku 4.5' }],
    has_more: false,
    first_id: 'claude-haiku-4-5',
    last_id: 'claude-haiku-4-5',
  });
  assert.equal(anthropic.shape, 'anthropic');
  assert.deepEqual(anthropic.models, [{ id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' }]);

  assert.equal(parseModelList('<html>'), null);
  assert.equal(parseModelList({ message: 'ok' }), null);
  assert.deepEqual(parseModelList({ models: [{ name: 'llama3:8b' }] }).models, [{ id: 'llama3:8b', name: '' }]);
});

test('prepareModels drops non-chat models, dedupes and sorts', () => {
  const models = ['gpt-4o', 'text-embedding-3-small', 'whisper-1', 'gpt-4.1-mini', 'gpt-4o', 'tts-1'].map((id) => ({ id, name: '' }));
  assert.deepEqual(
    prepareModels(models).map((m) => m.id),
    ['gpt-4.1-mini', 'gpt-4o'],
  );
  // Anthropic order (newest first) is preserved.
  const claude = ['claude-sonnet-4-5', 'claude-haiku-4-5'].map((id) => ({ id, name: '' }));
  assert.deepEqual(prepareModels(claude, 'anthropic').map((m) => m.id), ['claude-sonnet-4-5', 'claude-haiku-4-5']);
  // Never filter everything away.
  assert.deepEqual(prepareModels([{ id: 'text-embedding-3-small', name: '' }]).map((m) => m.id), ['text-embedding-3-small']);
});

test('pickDefaultModel and chooseModel', () => {
  const list = (ids) => ids.map((id) => ({ id, name: '' }));
  assert.equal(pickDefaultModel(list(['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'])), 'claude-haiku-4-5');
  assert.equal(pickDefaultModel(list(['deepseek-chat', 'deepseek-reasoner'])), 'deepseek-chat');
  assert.equal(pickDefaultModel(list(['llama3:8b'])), 'llama3:8b');
  assert.equal(pickDefaultModel([]), '');

  const fresh = list(['gpt-4o', 'gpt-4o-mini']);
  assert.equal(chooseModel({ current: 'gpt-4o', models: fresh }), 'gpt-4o');
  assert.equal(chooseModel({ current: 'my-finetune', previousModels: [], models: fresh }), 'my-finetune');
  assert.equal(chooseModel({ current: 'claude-haiku-4-5', previousModels: list(['claude-haiku-4-5']), models: fresh }), 'gpt-4o-mini');
  assert.equal(chooseModel({ current: '', models: fresh }), 'gpt-4o-mini');
});

// --- detectEndpoint against a fake fetch --------------------------------

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeServer(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { url, method: init.method || 'GET', headers, body: init.body };
    calls.push(req);
    for (const route of routes) {
      const res = route(req);
      if (res) return typeof res === 'function' ? res() : res;
    }
    return json(404, { error: { message: 'not found' } });
  };
  return { fetchImpl, calls };
}

const openaiModels = { object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model' }, { id: 'gpt-4o', object: 'model' }] };
const anthropicModels = {
  data: [
    { id: 'claude-sonnet-4-5', type: 'model', display_name: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5', type: 'model', display_name: 'Claude Haiku 4.5' },
  ],
  has_more: false,
  first_id: 'claude-sonnet-4-5',
  last_id: 'claude-haiku-4-5',
};

const openaiServer = (base, key) => (req) => {
  if (req.url !== `${base}/models`) return null;
  if (req.headers.authorization !== `Bearer ${key}`) return json(401, { error: { message: 'Incorrect API key', type: 'invalid_request_error' } });
  return json(200, openaiModels);
};

const anthropicServer = (base, key) => (req) => {
  if (req.url !== `${base}/models`) return null;
  if (req.headers['x-api-key'] !== key) {
    return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  }
  return json(200, anthropicModels);
};

test('detects an OpenAI-compatible endpoint from a bare host', async () => {
  const { fetchImpl } = fakeServer([openaiServer('https://api.example.com/v1', 'sk-1')]);
  const r = await detectEndpoint({ baseUrl: 'api.example.com', apiKey: 'sk-1', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.type, 'openai');
  assert.equal(r.baseUrl, 'https://api.example.com/v1');
  assert.deepEqual(r.models.map((m) => m.id), ['gpt-4o', 'gpt-4o-mini']);
});

test('detects an Anthropic-compatible endpoint even without a URL hint', async () => {
  const { fetchImpl, calls } = fakeServer([anthropicServer('https://relay.example.com/v1', 'k')]);
  const r = await detectEndpoint({ baseUrl: 'https://relay.example.com/v1/messages', apiKey: 'k', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.type, 'anthropic');
  assert.equal(r.baseUrl, 'https://relay.example.com/v1');
  assert.deepEqual(r.models.map((m) => m.id), ['claude-sonnet-4-5', 'claude-haiku-4-5']);
  const anthropicCall = calls.find((c) => c.headers['x-api-key']);
  assert.equal(anthropicCall.headers['anthropic-version'], '2023-06-01');
});

test('prefers the URL hint when a proxy speaks both protocols', async () => {
  const routes = [openaiServer('https://both.example.com/v1', 'k'), anthropicServer('https://both.example.com/v1', 'k')];
  // Bearer requests hit the OpenAI route first; x-api-key requests fall through to Anthropic.
  const dual = (req) => (req.headers['x-api-key'] ? routes[1](req) : routes[0](req));
  const { fetchImpl } = fakeServer([dual]);
  const r = await detectEndpoint({ baseUrl: 'https://both.example.com/v1', apiKey: 'k', fetchImpl });
  assert.equal(r.type, 'openai');

  const { fetchImpl: f2 } = fakeServer([(req) => dual({ ...req, url: req.url.replace('claude.', 'both.') })]);
  const r2 = await detectEndpoint({ baseUrl: 'https://claude.example.com/v1', apiKey: 'k', fetchImpl: f2 });
  assert.equal(r2.type, 'anthropic');
});

test('a public OpenAI-shaped model list is not mistaken for Anthropic', async () => {
  const { fetchImpl } = fakeServer([(req) => (req.url === 'https://openrouter.ai/api/v1/models' ? json(200, { data: [{ id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' }] }) : null)]);
  const r = await detectEndpoint({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', fetchImpl });
  assert.equal(r.type, 'openai');
});

test('honors a forced protocol', async () => {
  const { fetchImpl, calls } = fakeServer([anthropicServer('https://x.example.com/v1', 'k')]);
  const r = await detectEndpoint({ baseUrl: 'https://x.example.com/v1', apiKey: 'k', type: 'anthropic', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.type, 'anthropic');
  assert.ok(calls.every((c) => !c.headers.authorization));
});

test('reports an invalid key with the detected protocol', async () => {
  const { fetchImpl } = fakeServer([anthropicServer('https://api.anthropic.com/v1', 'right')]);
  const r = await detectEndpoint({ baseUrl: 'https://api.anthropic.com', apiKey: 'wrong', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'auth');
  assert.match(r.error.message, /Anthropic/);
  assert.equal(r.error.detail, 'invalid x-api-key');
});

test('reports unreachable hosts without probing further', async () => {
  const { fetchImpl, calls } = fakeServer([
    () => () => {
      throw new TypeError('fetch failed');
    },
  ]);
  const r = await detectEndpoint({ baseUrl: 'https://down.example.com', apiKey: 'k', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'network');
  assert.equal(calls.length, 2); // one base, both protocols
});

test('falls back to the chat endpoint when /models is missing', async () => {
  const { fetchImpl } = fakeServer([
    (req) =>
      req.url === 'https://nomodels.example.com/v1/chat/completions' && req.method === 'POST'
        ? json(400, { error: { message: 'model is required', type: 'invalid_request_error' } })
        : null,
  ]);
  const r = await detectEndpoint({ baseUrl: 'https://nomodels.example.com/v1', apiKey: 'k', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.type, 'openai');
  assert.deepEqual(r.models, []);
  assert.match(r.warning, /手动输入/);
});

test('reports not_found when nothing answers', async () => {
  const { fetchImpl } = fakeServer([]);
  const r = await detectEndpoint({ baseUrl: 'https://nothing.example.com', apiKey: 'k', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

test('rejects an invalid URL before any request', async () => {
  const { fetchImpl, calls } = fakeServer([]);
  const r = await detectEndpoint({ baseUrl: 'ftp://x', apiKey: 'k', fetchImpl });
  assert.equal(r.error.code, 'invalid_url');
  assert.equal(calls.length, 0);
});
