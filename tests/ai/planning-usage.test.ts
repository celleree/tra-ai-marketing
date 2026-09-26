import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithProviderUsage, withProviderUsageContext } from '@/lib/ai/provider-telemetry';
import { withPaidPreparationScope, checkpointPaidPreparation } from '@/lib/creatives/preparation-checkpoint';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';

const url = 'https://api.openai.com/v1/responses';
const request = { method: 'POST', headers: { Authorization: 'Bearer PRIVATE' }, signal: new AbortController().signal,
  body: JSON.stringify({ model: 'gpt-6-astra', input: 'PRIVATE', store: false }) };
const response = () => Response.json({ status: 'completed', output: 'PRIVATE', service_tier: 'default', usage: {
  input_tokens: 100, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 }, output_tokens: 5,
} }, { headers: { 'x-request-id': 'req_plan' } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('planning usage attribution', () => {
  it.each(['production', 'preview'])('preserves Responses dispatch with invalid image-only configuration in %s', async environment => {
    vi.stubEnv('TRA_IMAGE_PURPOSE', 'invalid-image-purpose'); vi.stubEnv('VERCEL_ENV', environment); vi.stubEnv('NODE_ENV', 'production');
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {}); const dispatch = vi.fn(async () => response());
    expect((await fetchWithProviderUsage('creative-plan', url, request, dispatch)).ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logs.mock.calls[1][0])).purpose).toBe(environment === 'production' ? 'production' : 'diagnostic');
  });
  it('preserves request/response and records batch usage without allocating creative billing', async () => {
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {}); const result = response();
    const dispatch = vi.fn<typeof fetch>(async () => result);
    expect(await withProviderUsageContext({ runId: 'run1', portfolioId: 'p1' },
      () => fetchWithProviderUsage('creative-plan', url, request, dispatch))).toBe(result);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(url, request); expect(dispatch.mock.calls[0][1]).toBe(request);
    const events = logs.mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(events[1]).toMatchObject({ stage: 'creative-plan', endpoint: 'responses', model: 'gpt-6-astra',
      runId: 'run1', portfolioId: 'p1', creativeId: null, requestId: 'req_plan', status: 'succeeded', estimatedCostUsd: .001095 });
    expect(events[0].attemptId).toEqual(events[1].attemptId); expect(JSON.stringify(events)).not.toContain('PRIVATE');
    expect(await result.json()).toHaveProperty('output', 'PRIVATE');
  });
  it('does not repeat paid preparation or its usage on a completed checkpoint', async () => {
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {}); const dispatch = vi.fn(async () => response());
    const storage = new MemoryPortfolioStorage();
    const work = () => withPaidPreparationScope({ runId: 'run1', storage }, () => checkpointPaidPreparation('plan', {}, async () => {
      await fetchWithProviderUsage('creative-plan', url, request, dispatch); return 'saved';
    }));
    expect(await work()).toBe('saved'); expect(await work()).toBe('saved');
    expect(dispatch).toHaveBeenCalledTimes(1); expect(logs).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(logs.mock.calls[1][0])).runId).toBe('run1');
  });
  it.each(['failed', 'incomplete', 'cancelled', 'in_progress'])("reports Responses status %s without dropping usage", async status => {
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    const result = Response.json({ status, usage: { input_tokens: 10 } });
    expect(await fetchWithProviderUsage('creative-plan', url, request, async () => result)).toBe(result);
    expect(JSON.parse(String(logs.mock.calls[1][0]))).toMatchObject({ status: status === 'in_progress' ? 'unknown' : 'failed',
      usage: { inputTokens: 10 }, estimatedCostUsd: null });
  });
  it('isolates concurrent run attribution', async () => {
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    await Promise.all(['a', 'b'].map(runId => withProviderUsageContext({ runId },
      () => fetchWithProviderUsage('plan', url, request, async () => { await Promise.resolve(); return response(); }))));
    const events = logs.mock.calls.map(([value]) => JSON.parse(String(value)));
    for (const run of ['a', 'b']) expect(events.filter(e => e.runId === run).map(e => e.status)).toEqual(['started', 'succeeded']);
  });
});
