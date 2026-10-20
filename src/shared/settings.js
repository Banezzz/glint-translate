import { candidateBaseUrls, guessTypeFromUrl, normalizeBaseUrl } from './providers.js';

export const STORAGE_KEY = 'settings';

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  provider: Object.freeze({
    baseUrl: '',
    apiKey: '',
    // 'auto' | 'openai' | 'anthropic'
    type: 'auto',
    model: '',
    models: [],
    // Result of the last successful detection; only valid while `from`
    // still equals the normalized baseUrl.
    resolved: null,
  }),
  targetLang: 'zh-CN',
  secondLang: 'en',
  // 'icon' | 'auto' | 'manual'
  trigger: 'icon',
  dictionary: true,
  // 'auto' | 'light' | 'dark'
  theme: 'auto',
  fontSize: 15,
  disabledSites: [],
  // Whole-page bilingual translation.
  floatBall: true,
  ballDisabledSites: [],
  // 'plain' | 'dashed' | 'faded' | 'highlight' | 'border'
  pageStyle: 'dashed',
});

export function mergeSettings(stored) {
  const base = structuredClone(DEFAULT_SETTINGS);
  if (!stored || typeof stored !== 'object') return base;
  return {
    ...base,
    ...stored,
    provider: { ...base.provider, ...(stored.provider || {}) },
  };
}

function storageArea() {
  return globalThis.chrome?.storage?.local;
}

export async function loadSettings(area = storageArea()) {
  const { [STORAGE_KEY]: stored } = await area.get(STORAGE_KEY);
  return mergeSettings(stored);
}

export async function updateSettings(patch, area = storageArea()) {
  const current = await loadSettings(area);
  const next = mergeSettings({
    ...current,
    ...patch,
    provider: { ...current.provider, ...(patch.provider || {}) },
  });
  await area.set({ [STORAGE_KEY]: next });
  return next;
}

// The concrete endpoint the translator should call, derived from what the
// user typed plus the last detection result.
export function effectiveProvider(provider) {
  const normalized = normalizeBaseUrl(provider.baseUrl);
  const resolved = provider.resolved && provider.resolved.from === normalized ? provider.resolved : null;
  const type = provider.type !== 'auto' ? provider.type : resolved?.type || guessTypeFromUrl(normalized);
  const baseUrl = resolved?.baseUrl || candidateBaseUrls(normalized)[0] || '';
  return { type, baseUrl, apiKey: provider.apiKey, model: provider.model.trim() };
}

export function isProviderReady(settings) {
  const p = effectiveProvider(settings.provider);
  return Boolean(p.baseUrl && p.model);
}

export function isSiteDisabled(settings, hostname) {
  return Boolean(hostname) && settings.disabledSites.includes(hostname);
}
