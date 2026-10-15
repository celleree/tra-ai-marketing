import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeImageAttempt, imageAttemptBudget, withImageAttemptScope } from '@/lib/creatives/image-attempt-execution';
import { fetchCreativeImage, runCreativeImageModelRoute, creativeImageHttpError } from '@/lib/creatives/image-models';
import { prepareImageRenderRequest } from '@/lib/creatives/image-render-request';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';

const endpoint = 'https://api.openai.com/v1/images/generations';
const request = (model = 'gpt-image-2.5-sunburst') => prepareImageRenderRequest(endpoint, { method: 'POST',
  body: JSON.stringify({ model, prompt: 'Approved fixture', size: '1024x1024' }) });
const response = () => new Response(JSON.stringify({ data: [{ b64_json: 'cHVyY2hhc2VkIGJ5dGVz' }], usage: { total_tokens: 12 } }));
const scope = (storage = new MemoryPortfolioStorage(), operationId = 'slot-a') => ({ storage, runId: 'portfolio-a', operationId,
  budget: { purpose: 'production' as const, primaryLimit: 2, fallbackLimit: 1 } });
afterEach(() => vi.unstubAllEnvs());

describe('paid image execution', () => {
  it('reuses purchased bytes after deterministic finalization fails', async () => {
    const owned = scope(); const dispatch = vi.fn(async () => response());
    await expect(withImageAttemptScope(owned, async () => {
      await executeImageAttempt(endpoint, request(), dispatch); throw new Error('Logo persistence failed');
    })).rejects.toThrow('Logo persistence');
    const replay = await withImageAttemptScope(owned, () => executeImageAttempt(endpoint, request(), dispatch));
    expect(await replay.json()).toEqual(await response().json());
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('admits only one concurrent primary and permits another intentional operation', async () => {
    const owned = scope(); let release!: (value: Response) => void;
    const dispatch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const first = withImageAttemptScope(owned, () => executeImageAttempt(endpoint, request(), dispatch));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    await expect(withImageAttemptScope(owned, () => executeImageAttempt(endpoint, request(), dispatch))).rejects.toThrow('BUSY');
    release(response()); await first;
    await withImageAttemptScope({ ...owned, operationId: 'slot-b' }, () => executeImageAttempt(endpoint, request(), async () => response()));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('does not repurchase unknown network outcomes or missing output', async () => {
    for (const result of [() => Promise.reject(new TypeError('socket closed')), async () => new Response('{}')]) {
      const owned = scope(); const dispatch = vi.fn(result);
      await expect(withImageAttemptScope(owned, () => executeImageAttempt(endpoint, request(), dispatch))).rejects.toThrow('no repeat purchase');
      await expect(withImageAttemptScope(owned, () => executeImageAttempt(endpoint, request(), dispatch))).rejects.toThrow();
      expect(dispatch).toHaveBeenCalledTimes(1);
    }
  });
  it('fails closed on missing raw storage and changed request inputs', async () => {
    const owned = scope(); const dispatch = vi.fn(async () => response());
    await withImageAttemptScope(owned, () => executeImageAttempt(endpoint, request(), dispatch));
    await expect(withImageAttemptScope(owned, () => executeImageAttempt(endpoint,
      { ...request(), body: String(request().body).replace('Approved', 'Changed') }, dispatch))).rejects.toThrow('inputs changed');
    for (const key of owned.storage.data.keys()) if (key.startsWith('paid-image-results/')) owned.storage.data.delete(key);
    await expect(withImageAttemptScope(owned, () => executeImageAttempt(endpoint, request(), dispatch))).rejects.toThrow('unavailable');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('cannot repeat a purchase after raw persistence fails', async () => {
    const owned = scope(); const write = owned.storage.write.bind(owned.storage);
    owned.storage.write = async (key, bytes, etag) => {
      if (key.startsWith('paid-image-results/')) throw new Error('Storage outage');
      return write(key, bytes, etag);
    };
    const dispatch = vi.fn(async () => response());
    await expect(withImageAttemptScope(owned, () => executeImageAttempt(endpoint, request(), dispatch))).rejects.toThrow('durable');
    await expect(withImageAttemptScope(owned, () => executeImageAttempt(endpoint, request(), dispatch))).rejects.toThrow('BUSY');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('resumes a confirmed primary failure and saved fallback without repeating either call', async () => {
    const owned = scope(); const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ error: { code: 'server_is_overloaded' } }, { status: 503 })).mockResolvedValueOnce(response());
    const render = () => withImageAttemptScope(owned, () => runCreativeImageModelRoute({ operationType: 'PROMPT_GENERATION',
      generate: async model => {
        const result = await fetchCreativeImage(endpoint, request(model));
        if (!result.ok) throw creativeImageHttpError(result.status, 'Provider unavailable');
        return result.json();
      } }));
    expect((await render()).routing.fallbackUsed).toBe(true);
    expect((await render()).routing.fallbackUsed).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2); fetcher.mockRestore();
  });
  it('enforces purpose budgets across slots and isolates concurrent run scopes', async () => {
    vi.stubEnv('TRA_IMAGE_PURPOSE', 'diagnostic');
    expect(imageAttemptBudget(12)).toEqual({ purpose: 'diagnostic', primaryLimit: 1, fallbackLimit: 0 });
    const owned = { ...scope(), budget: imageAttemptBudget(12) }; const dispatch = vi.fn(async () => response());
    await withImageAttemptScope(owned, () => executeImageAttempt(endpoint, request(), dispatch));
    await expect(withImageAttemptScope({ ...owned, operationId: 'slot-b' }, () => executeImageAttempt(endpoint, request(), dispatch))).rejects.toThrow('budget');
    await Promise.all(['portfolio-b', 'portfolio-c'].map(runId => withImageAttemptScope({ ...owned, runId }, () => executeImageAttempt(endpoint, request(), dispatch))));
    expect(dispatch).toHaveBeenCalledTimes(3);
    vi.stubEnv('TRA_IMAGE_PURPOSE', 'staging-smoke');
    expect(imageAttemptBudget(2)).toEqual({ purpose: 'staging-smoke', primaryLimit: 2, fallbackLimit: 0 });
  });
});
