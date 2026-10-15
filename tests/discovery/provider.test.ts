import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDataset, readRun, startSearch } from '@/lib/discovery/provider';
import { parseSearch } from '@/lib/discovery/model';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const enable = () => { vi.stubEnv('DISCOVERY_PROVIDER_ACCESS_APPROVED', 'true'); vi.stubEnv('DISCOVERY_PAID_EXECUTION_ENABLED', 'true'); vi.stubEnv('APIFY_TOKEN', 'fixture-token'); };
describe('gated Apify contract (mocked, no provider calls)', () => {
  it('fails closed even when a token exists without both approvals', async () => {
    vi.stubEnv('APIFY_TOKEN', 'fixture-token'); vi.stubEnv('DISCOVERY_PROVIDER_ACCESS_APPROVED', 'false'); vi.stubEnv('DISCOVERY_PAID_EXECUTION_ENABLED', 'false');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(startSearch(parseSearch({ query: 'free consultation' }))).rejects.toThrow('disabled'); expect(fetch).not.toHaveBeenCalled();
  });
  it('submits one bounded URL without add-ons, then checks status and bounded dataset', async () => {
    enable(); const fetch = vi.fn().mockResolvedValueOnce(Response.json({ data: { id: 'runABC', status: 'RUNNING' } })).mockResolvedValueOnce(Response.json({ data: { id: 'runABC', status: 'SUCCEEDED', defaultDatasetId: 'datasetABC' } })).mockResolvedValueOnce(Response.json([])); vi.stubGlobal('fetch', fetch);
    await startSearch(parseSearch({ query: 'consultation', limit: 100 })); await readRun('runABC'); await readDataset('datasetABC', 100);
    const [url, options] = fetch.mock.calls[0]; expect(url).toContain('/acts/apify~facebook-ads-scraper/runs?timeout=180'); expect(url).not.toContain('fixture-token');
    const input = JSON.parse(options.body); expect(input.startUrls).toHaveLength(1); expect(input.resultsLimit).toBe(100); expect(input.isDetailsPerAd).toBe(false);
    expect(options.headers.Authorization).toBe('Bearer fixture-token'); expect(fetch.mock.calls[2][0]).toContain('limit=100');
  });
  it('does not retry paid failures or expose provider response bodies', async () => {
    enable(); const fetch = vi.fn().mockResolvedValue(new Response('secret provider detail', { status: 429 })); vi.stubGlobal('fetch', fetch);
    await expect(startSearch(parseSearch({ query: 'consultation' }))).rejects.toThrow('429'); expect(fetch).toHaveBeenCalledTimes(1);
    await expect(readRun('../other')).rejects.toThrow('identifier');
  });
  it('rejects missing run identifiers rather than coercing undefined to a valid ID', async () => {
    enable(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: { status: 'RUNNING' } })));
    await expect(startSearch(parseSearch({ query: 'consultation' }))).rejects.toThrow('Invalid provider run');
  });
});
