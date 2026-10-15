import { DiscoveryError } from './errors';
import type { Search } from './model';
const BASE = 'https://api.apify.com/v2';
export const ACTOR = 'apify~facebook-ads-scraper';
export function providerAvailable() {
  return process.env.DISCOVERY_PROVIDER_ACCESS_APPROVED === 'true' && process.env.DISCOVERY_PAID_EXECUTION_ENABLED === 'true' && Boolean(process.env.APIFY_TOKEN?.trim());
}
export function assertProviderAvailable() {
  if (!providerAvailable()) throw new DiscoveryError('Live discovery is disabled. Authorized provider access, paid-execution approval, and APIFY_TOKEN are required.');
}
async function request(path: string, init?: RequestInit) {
  assertProviderAvailable();
  const response = await fetch(`${BASE}${path}`, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN!.trim()}`, 'Content-Type': 'application/json' } });
  if (!response.ok) throw new DiscoveryError(`Discovery provider returned ${response.status}. No automatic retry was made.`);
  return response.json();
}
export type ProviderRun = { id: string; status: string; defaultDatasetId?: string };
function parseRun(value: unknown): ProviderRun {
  const data = (value as { data?: ProviderRun })?.data;
  if (!data || typeof data.id !== 'string' || !/^[a-zA-Z0-9]{1,100}$/.test(data.id) || typeof data.status !== 'string' || !data.status || data.status.length > 40) throw new DiscoveryError('Invalid provider run response.');
  if (data.defaultDatasetId !== undefined && (typeof data.defaultDatasetId !== 'string' || !/^[a-zA-Z0-9]{1,100}$/.test(data.defaultDatasetId))) throw new DiscoveryError('Invalid provider dataset response.');
  return { id: data.id, status: data.status, defaultDatasetId: data.defaultDatasetId };
}
export async function startSearch(search: Search) {
  const url = new URL('https://www.facebook.com/ads/library/');
  for (const [key, value] of Object.entries({ q: search.query, country: 'US', ad_type: 'all', media_type: 'image', active_status: 'all', search_type: 'keyword_unordered' })) url.searchParams.set(key, value);
  // One URL: resultsLimit is PER URL, not a global actor limit. No paid add-ons.
  return parseRun(await request(`/acts/${ACTOR}/runs?timeout=180`, { method: 'POST', body: JSON.stringify({ startUrls: [{ url: url.toString() }], resultsLimit: search.limit, includeAboutPage: false, isDetailsPerAd: false }) }));
}
export async function readRun(runId: string) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9]{1,100}$/.test(runId)) throw new DiscoveryError('Invalid run identifier.');
  const run = parseRun(await request(`/actor-runs/${runId}`));
  if (run.id !== runId) throw new DiscoveryError('Provider returned a different run.');
  return run;
}
export async function readDataset(datasetId: string, limit: number): Promise<unknown> {
  if (typeof datasetId !== 'string' || !/^[a-zA-Z0-9]{1,100}$/.test(datasetId) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new DiscoveryError('Invalid dataset request.');
  return request(`/datasets/${datasetId}/items?format=json&clean=true&limit=${limit}`);
}
