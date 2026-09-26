import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageProviderFailure } from '@/lib/creatives/image-provider-failure';
import { fetchCreativeImage, runCreativeImageModelRoute, creativeImageMissingOutputError } from '@/lib/creatives/image-models';
import { withImageAttemptScope } from '@/lib/creatives/image-attempt-execution';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';

const endpoint = 'https://api.openai.com/v1/images/generations';
const run = (storage: MemoryPortfolioStorage) => withImageAttemptScope({ storage, runId: 'run', operationId: 'image',
  budget: { purpose: 'production', primaryLimit: 1, fallbackLimit: 1 } }, () => runCreativeImageModelRoute({
    operationType: 'PROMPT_GENERATION', generate: async model => {
      const response = await fetchCreativeImage(endpoint, { method: 'POST',
        body: JSON.stringify({ model, prompt: 'Fixture', size: '1024x1024' }) });
      const body = await response.json(); if (!body.data?.[0]?.b64_json) throw creativeImageMissingOutputError();
      return body;
    },
  }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('image provider failure admission', () => {
  it.each(['insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_exhausted',
    'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded'])
  ('never falls back for terminal %s, including replay', async code => {
    const fetcher = vi.fn(async () => Response.json({ error: { code, type: 'rate_limit_error', message: 'PRIVATE SENTINEL' } }, { status: 429 }));
    vi.stubGlobal('fetch', fetcher); const storage = new MemoryPortfolioStorage();
    await expect(run(storage)).rejects.not.toThrow('PRIVATE SENTINEL');
    await expect(run(storage)).rejects.toThrow('Previously recorded'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([400, 401, 403, 404, 422])('does not retry deterministic HTTP %i', async status => {
    const failure = await imageProviderFailure(Response.json({ error: { message: 'PRIVATE SENTINEL' } }, { status }));
    expect(failure.fallbackReason).toBeNull(); expect(failure.outcome).toBe('FAILED'); expect(failure.message).not.toContain('PRIVATE');
  });
  it.each([408, 500, 502, 503, 504])('treats an unclassified HTTP %i outcome as unknown', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Gateway failure', { status })));
    const storage = new MemoryPortfolioStorage(); await expect(run(storage)).rejects.toThrow('unknown');
    await expect(run(storage)).rejects.toThrow('UNKNOWN'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['network', 'missing-output'])('makes no automatic replacement for %s', async kind => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (kind === 'network') throw new TypeError('Sensitive socket details');
      return Response.json({ data: [] });
    }));
    const storage = new MemoryPortfolioStorage(); await expect(run(storage)).rejects.toThrow('no repeat purchase');
    await expect(run(storage)).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([[429, 'rate_limit_exceeded'], [503, 'server_is_overloaded']] as const)
  ('reserves exactly one fallback after confirmed HTTP %i %s', async (status, code) => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: { code } }, { status }))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: 'c2F2ZWQ=' }] }));
    vi.stubGlobal('fetch', fetcher); const storage = new MemoryPortfolioStorage();
    expect((await run(storage)).routing.fallbackUsed).toBe(true);
    expect((await run(storage)).routing.fallbackUsed).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
    const record = [...storage.data.entries()].find(([key]) => key.startsWith('paid-image-runs/'))![1];
    expect(Object.keys(JSON.parse(record.bytes.toString()).attempts)).toHaveLength(2);
  });
  it('honors a requested provider delay and forbids staging-smoke fallback', async () => {
    const delayed = await imageProviderFailure(Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429, headers: { 'Retry-After': '60' } }));
    expect(delayed.fallbackReason).toBeNull();
    vi.stubEnv('TRA_IMAGE_PURPOSE', 'staging-smoke');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'server_is_overloaded' } }, { status: 503 })));
    await expect(run(new MemoryPortfolioStorage())).rejects.toThrow('HTTP 503'); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
