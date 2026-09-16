import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPortfolio, type PortfolioResponse } from '@/lib/creatives/portfolio-client';
import { portfolioProgress } from '@/lib/creatives/portfolio-progress';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { portfolioRequest } from '../fixtures/creative-portfolio';

const initial = (): PortfolioResponse => ({ job: portfolioProgress(newCreativePortfolio(portfolioRequest())), creatives: [] });
const progressed = (value: PortfolioResponse): PortfolioResponse => ({
  ...value, job: { ...value.job, planningCheckpoint: value.job.planningCheckpoint + 1 },
});
const deferredResponse = () => {
  let resolve!: (value: Response) => void;
  return { promise: new Promise<Response>(settle => { resolve = settle; }), resolve };
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('portfolio Stop controller semantics', () => {
  it('stops after a normal in-flight advance settles and keeps its durable response', async () => {
    const value = initial(), next = progressed(value), pending = deferredResponse();
    const fetchMock = vi.fn(() => pending.promise); vi.stubGlobal('fetch', fetchMock);
    let stopped = false; const update = vi.fn();
    const running = runPortfolio(value, update, () => stopped);
    expect(fetchMock).toHaveBeenCalledOnce();
    stopped = true; pending.resolve(Response.json(next));
    const completed = await running;
    expect(completed.job.planningCheckpoint).toBe(next.job.planningCheckpoint);
    expect(update).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not begin another advance when Stop is requested as a successful response is applied', async () => {
    const value = initial(), next = progressed(value), fetchMock = vi.fn().mockResolvedValue(Response.json(next));
    vi.stubGlobal('fetch', fetchMock); let stopped = false;
    const completed = await runPortfolio(value, () => { stopped = true; }, () => stopped);
    expect(completed.job.planningCheckpoint).toBe(next.job.planningCheckpoint);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('skips Retry-After sleep and another advance when Stop is requested during an in-flight BUSY response', async () => {
    const value = initial(), pending = deferredResponse(), fetchMock = vi.fn(() => pending.promise);
    vi.stubGlobal('fetch', fetchMock); let stopped = false; const wait = vi.fn(async () => {}), update = vi.fn();
    const running = runPortfolio(value, update, () => stopped, wait);
    expect(fetchMock).toHaveBeenCalledOnce();
    stopped = true; pending.resolve(Response.json(value, { status: 202, headers: { 'Retry-After': '4' } }));
    const completed = await running;
    expect(wait).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledOnce(); expect(update).toHaveBeenCalledOnce();
    expect(completed.retryAfterMs).toBe(4000); expect(completed.error).toBeUndefined();
    expect(completed.job).toEqual(value.job); expect(completed.creatives).toEqual(value.creatives);
    expect(completed.job.slots.some(slot => slot.status === 'RETRY_REQUIRED')).toBe(false);
  });

  it('preserves normal BUSY Retry-After behavior when Stop was not requested', async () => {
    const value = initial(), next = progressed(value);
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(value, { status: 202, headers: { 'Retry-After': '3' } }))
      .mockResolvedValueOnce(Response.json(next));
    vi.stubGlobal('fetch', fetchMock); const wait = vi.fn(async () => {}); let updates = 0;
    const completed = await runPortfolio(value, () => { updates += 1; }, () => updates === 2, wait);
    expect(completed.job.planningCheckpoint).toBe(next.job.planningCheckpoint);
    expect(wait).toHaveBeenCalledOnce(); expect(wait).toHaveBeenCalledWith(3000); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('can explicitly resume the loop after a stopped run without fabricating progress', async () => {
    const value = initial(), first = progressed(value), second = progressed(first);
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json(second));
    vi.stubGlobal('fetch', fetchMock); let stopped = false;
    const stoppedResult = await runPortfolio(value, () => { stopped = true; }, () => stopped);
    expect(stoppedResult.job.planningCheckpoint).toBe(first.job.planningCheckpoint); expect(fetchMock).toHaveBeenCalledOnce();
    stopped = false;
    const resumedResult = await runPortfolio(stoppedResult, () => { stopped = true; }, () => stopped);
    expect(resumedResult.job.planningCheckpoint).toBe(second.job.planningCheckpoint); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resumedResult.job.slots).toEqual(value.job.slots);
  });
});
