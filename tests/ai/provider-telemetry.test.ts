import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeProviderAttempt, withProviderUsageContext } from '@/lib/ai/provider-telemetry';
import { fetchCreativeImage, runCreativeImageModelRoute } from '@/lib/creatives/image-models';
import { withImageAttemptScope } from '@/lib/creatives/image-attempt-execution';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';

const endpoint = 'https://api.openai.com/v1/images/generations';
const request = (model = 'gpt-image-2.5-sunburst') => ({ method: 'POST', headers: { Authorization: 'Bearer PRIVATE_KEY' },
  body: JSON.stringify({ model, prompt: 'PRIVATE_PROMPT', size: '1024x1024' }) });
const output = () => Response.json({ data: [{ b64_json: 'PRIVATE_PIXELS' }], usage: {
  input_tokens: 300, input_tokens_details: { text_tokens: 100, image_tokens: 200 }, output_tokens: 1000,
} }, { headers: { 'x-request-id': 'req_123' } });
const scope = () => ({ runId: 'run-1', operationId: 'creative-1', creativeId: 'creative-1', portfolioId: 'portfolio-1',
  jobId: 'portfolio-1', budget: { purpose: 'production' as const, primaryLimit: 1, fallbackLimit: 1 }, storage: new MemoryPortfolioStorage() });
const logs = () => {
  const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
  return () => spy.mock.calls.map(([value]) => JSON.parse(String(value)));
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('actual provider attempt telemetry', () => {
  it('attributes paid image output once and records raw replay without duplicate cost', async () => {
    const events = logs(); const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => output()); const owned = scope();
    const render = () => withProviderUsageContext({ operationType: 'REGENERATE' }, () => withImageAttemptScope(owned,
      () => fetchCreativeImage(endpoint, request())));
    await render(); await render();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(events().map(e => e.status)).toEqual(['started', 'succeeded', 'reused']);
    expect(new Set(events().map(e => e.attemptId)).size).toBe(1);
    expect(events()[1]).toMatchObject({ creativeId: 'creative-1', portfolioId: 'portfolio-1', jobId: 'portfolio-1',
      operationType: 'REGENERATE', requestId: 'req_123', quality: 'high', n: 1, dimensions: '1024x1024', retryIndex: 0,
      estimatedCostUsd: .0321, confirmedBilledCostUsd: null });
    expect(events()[1].renderFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(events()[2]).toMatchObject({ providerDispatched: false, usage: null, estimatedCostUsd: null });
    expect(JSON.stringify(events())).not.toContain('PRIVATE');
  });
  it('emits nothing for denied/busy duplicate dispatch and stops unknown replay', async () => {
    const events = logs(); const owned = scope(); const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('PRIVATE_SOCKET'));
    const render = () => withImageAttemptScope(owned, () => fetchCreativeImage(endpoint, request()));
    await expect(render()).rejects.toThrow(); await expect(render()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(events().map(e => e.status)).toEqual(['started', 'unknown']);
    expect(JSON.stringify(events())).not.toContain('PRIVATE');
  });
  it('keeps fallback a distinct paid attempt and reuses both recorded decisions', async () => {
    const events = logs(); const owned = scope(); const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ error: { code: 'server_is_overloaded', message: 'PRIVATE_ERROR' } }, { status: 503 }))
      .mockResolvedValueOnce(output());
    const render = () => withImageAttemptScope(owned, () => runCreativeImageModelRoute({ operationType: 'PROMPT_GENERATION',
      generate: model => fetchCreativeImage(endpoint, request(model)) }));
    await render(); await render(); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(events().map(e => e.status)).toEqual(['started', 'failed', 'started', 'succeeded', 'reused']);
    expect(events()[0].attemptId).not.toEqual(events()[2].attemptId);
    expect(events()[2]).toMatchObject({ model: 'gpt-image-2.5-flare', retryIndex: 1 });
    expect(JSON.stringify(events())).not.toContain('PRIVATE');
  });
  it('covers unscoped legacy calls and leaves missing usage unknown', async () => {
    const events = logs(); vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [{ b64_json: 'result' }] }));
    await fetchCreativeImage(endpoint, request());
    expect(events()[1]).toMatchObject({ status: 'succeeded', usage: null, estimatedCostUsd: null, runId: null });
  });
  it('does not make logger failure affect the paid response', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('log sink unavailable'); });
    const response = output();
    expect(await observeProviderAttempt({ attemptId: 'a', stage: 'image', endpoint: 'images', purpose: 'production' },
      async () => response)).toBe(response);
    expect(await response.json()).toHaveProperty('data');
  });
});
