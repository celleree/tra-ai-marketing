import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPortfolioSubmitter, requestPortfolio, runPortfolio, type PortfolioResponse } from '@/lib/creatives/portfolio-client';
import { portfolioProgress } from '@/lib/creatives/portfolio-progress';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { portfolioRequest } from '../fixtures/creative-portfolio';

const session = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; };
const initial = (): PortfolioResponse => ({ job: portfolioProgress(newCreativePortfolio(portfolioRequest())), creatives: [] });
const withSlots = (value: PortfolioResponse, statuses: Array<'PENDING' | 'SAVED' | 'RETRY_REQUIRED' | 'BLOCKED'>): PortfolioResponse => ({
  job: { ...value.job, planReady: true, planningPhase: 'READY_TO_RENDER', preparationFingerprint: undefined, lease: null,
    slots: value.job.slots.map((slot, index) => ({ ...slot, status: statuses[index],
      ...(['RETRY_REQUIRED', 'BLOCKED'].includes(statuses[index]) ? { error: statuses[index] === 'BLOCKED'
          ? 'Create a new portfolio with a smaller video pool; saved creatives remain available.' : 'Failed.' } : {}) })) },
  creatives: value.job.slots.filter((_, index) => statuses[index] === 'SAVED').map(slot => ({
    id: slot.creativeId, index: slot.index, category: 'customer-problems', format: 'direct-response',
    copy: { headline: 'Headline', primaryText: 'Copy', description: '' },
    image: { id: 'media_' + 'a'.repeat(32), fileName: 'saved.png', originalName: 'saved.png', mimeType: 'image/png', size: 100, url: '/saved.png' },
    finalization: { status: 'SAVED', createdAt: '2026-09-11T00:00:00.000Z' },
  })),
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('resumable portfolio browser controller', () => {
  it('preserves a submission key across transport retry and changes it only for a new action', async () => {
    const value = initial(); const fetcher = vi.fn().mockRejectedValueOnce(new Error('Lost response'))
      .mockImplementation(async () => Response.json(value));
    vi.stubGlobal('fetch', fetcher);
    const storage = session(); const submit = createPortfolioSubmitter(() => storage);
    await expect(submit(portfolioRequest())).rejects.toThrow('Lost response');
    await createPortfolioSubmitter(() => storage)(portfolioRequest());
    await createPortfolioSubmitter(() => storage)(portfolioRequest());
    const keys = fetcher.mock.calls.map(([, options]) => options.headers['Idempotency-Key']);
    expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[1]);
  });
  it('allocates a new submission when inputs change after a failed delivery', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Lost response')); vi.stubGlobal('fetch', fetcher);
    const storage = session(); const submit = createPortfolioSubmitter(() => storage);
    await expect(submit(portfolioRequest())).rejects.toThrow();
    await expect(submit({ ...portfolioRequest(), context: 'A different deliberate request' })).rejects.toThrow();
    expect(fetcher.mock.calls[0][1].headers['Idempotency-Key']).not.toBe(fetcher.mock.calls[1][1].headers['Idempotency-Key']);
  });
  it('parses bounded transient BUSY Retry-After timing without treating 429 as BUSY', async () => {
    const value = initial();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(value, { status: 202, headers: { 'Retry-After': '3' } }))
      .mockResolvedValueOnce(Response.json(value, { status: 202 }))
      .mockResolvedValueOnce(Response.json(value, { status: 202, headers: { 'Retry-After': 'later' } }))
      .mockResolvedValueOnce(Response.json(value, { status: 202, headers: { 'Retry-After': '999999' } }))
      .mockResolvedValueOnce(Response.json({ ...value, error: 'Quota reached' }, { status: 429, headers: { 'Retry-After': '60' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await requestPortfolio({ action: 'advance', id: value.job.id })).retryAfterMs).toBe(3000);
    expect((await requestPortfolio({ action: 'advance', id: value.job.id })).retryAfterMs).toBe(2000);
    expect((await requestPortfolio({ action: 'advance', id: value.job.id })).retryAfterMs).toBe(2000);
    expect((await requestPortfolio({ action: 'advance', id: value.job.id })).retryAfterMs).toBe(30000);
    const quota = await requestPortfolio({ action: 'advance', id: value.job.id });
    expect(quota.error).toBe('Quota reached'); expect(quota.retryAfterMs).toBeUndefined();
  });
  it('accepts repeated unchanged BUSY responses, waits between advances, then resumes real progress', async () => {
    const value = initial();
    const progressed = { ...value, job: { ...value.job, planningCheckpoint: value.job.planningCheckpoint + 1 } };
    const responses = [
      Response.json(value, { status: 202, headers: { 'Retry-After': '1' } }),
      Response.json(value, { status: 202, headers: { 'Retry-After': '2' } }),
      Response.json(progressed),
    ];
    const events: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _options?: RequestInit) => {
      events.push('fetch'); return responses.shift()!;
    });
    vi.stubGlobal('fetch', fetchMock);
    const wait = vi.fn(async (delay: number) => { events.push('wait:' + delay); }); let updates = 0;
    const completed = await runPortfolio(value, () => { updates += 1; }, () => updates === 3, wait);
    expect(completed.job.planningCheckpoint).toBe(progressed.job.planningCheckpoint);
    expect(events).toEqual(['fetch', 'wait:1000', 'fetch', 'wait:2000', 'fetch']);
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(String(options?.body)).action)).toEqual(['advance', 'advance', 'advance']);
  });
  it('does not issue another request when paused while a BUSY wait resolves', async () => {
    const value = initial(); let paused = false;
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(value, { status: 202, headers: { 'Retry-After': '4' } }));
    vi.stubGlobal('fetch', fetchMock);
    const wait = vi.fn(async () => { paused = true; }), update = vi.fn();
    const completed = await runPortfolio(value, update, () => paused, wait);
    expect(completed.retryAfterMs).toBe(4000);
    expect(wait).toHaveBeenCalledWith(4000); expect(update).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('surfaces expired planning work without automatically retrying the uncertain call', async () => {
    const value = initial();
    value.job.lease = { slotIndex: null, expiresAtMs: Date.now() - 1 };
    const interrupted = { ...value, job: { ...value.job, lease: null, planningError: 'Previous planning was interrupted.' } };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(interrupted));
    vi.stubGlobal('fetch', fetchMock);
    expect((await runPortfolio(value, vi.fn(), () => false)).job.planningError).toBe(interrupted.job.planningError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).action).toBe('advance');
  });
  it('continues across durable preparation checkpoints that stay in INITIAL_PLAN', async () => {
    const value = initial();
    const first = { ...value, job: { ...value.job, planningCheckpoint: value.job.planningCheckpoint + 1 } };
    const second = { ...value, job: { ...value.job, planningCheckpoint: value.job.planningCheckpoint + 2 } };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json(second));
    vi.stubGlobal('fetch', fetchMock);
    let updates = 0;
    const completed = await runPortfolio(value, () => { updates += 1; }, () => updates === 2);
    expect(completed.job).toMatchObject({ planningPhase: 'INITIAL_PLAN', planningCheckpoint: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).action)).toEqual(['advance', 'advance']);
  });
  it('accepts durable preparation progress when the coarse checkpoint count stays the same', async () => {
    const firstJob = newCreativePortfolio(portfolioRequest());
    if (firstJob.planning.phase !== 'INITIAL_PLAN') throw new Error('Expected initial planning state.');
    firstJob.planning.preparation.analysis = {
      summary: 'Initial analysis', visibleText: [], visualStructure: 'Structure', hookOrAngle: 'Angle',
      offerOrCta: 'CTA', styleNotes: 'Style', preserve: [], avoid: [], unknowns: [], dominantCategory: 'customer-problems',
    };
    const secondJob = structuredClone(firstJob);
    if (secondJob.planning.phase !== 'INITIAL_PLAN') throw new Error('Expected initial planning state.');
    secondJob.planning.preparation.analysis!.summary = 'Updated persisted analysis';
    const first: PortfolioResponse = { job: portfolioProgress(firstJob), creatives: [] };
    const second: PortfolioResponse = { job: portfolioProgress(secondJob), creatives: [] };
    expect(first.job.planningCheckpoint).toBe(second.job.planningCheckpoint);
    expect(first.job.preparationFingerprint).not.toBe(second.job.preparationFingerprint);
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(second));
    vi.stubGlobal('fetch', fetchMock);
    let updates = 0;
    const completed = await runPortfolio(first, () => { updates += 1; }, () => updates === 1);
    expect(completed.job.preparationFingerprint).toBe(second.job.preparationFingerprint);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('waits for shared child video work, then probes it without treating GET as progress', async () => {
    const value = initial();
    value.job.videoPreparation = { total: 1, completed: 0, phase: 'TRANSCRIBING', busy: true };
    const ready = { ...value, job: { ...value.job,
      videoPreparation: { total: 1, completed: 1, phase: 'COMPLETE' as const, busy: false } } };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(ready)); vi.stubGlobal('fetch', fetchMock);
    const wait = vi.fn(async () => {}), update = vi.fn();
    await runPortfolio(value, update, () => update.mock.calls.length === 1, wait);
    expect(wait).toHaveBeenCalledOnce(); expect(wait).toHaveBeenCalledWith(2000); expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).action).toBe('advance');
  });
  it('reopens without paid work, polls an active lease, then advances only pending work', async () => {
    const value = withSlots(initial(), ['PENDING', 'PENDING']);
    value.job.lease = { slotIndex: 1, expiresAtMs: Date.now() + 60000 };
    const first = withSlots(value, ['SAVED', 'PENDING']), complete = withSlots(value, ['SAVED', 'SAVED']);
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(value)).mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json(complete));
    vi.stubGlobal('fetch', fetchMock);
    const loaded = await requestPortfolio({ action: 'load', id: value.job.id });
    expect(fetchMock).toHaveBeenCalledOnce();
    const updates = vi.fn(), wait = vi.fn(async () => {});
    expect((await runPortfolio(loaded, updates, () => false, wait)).creatives).toHaveLength(2);
    expect(fetchMock.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'GET', 'PATCH']);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).action).toBe('advance');
    expect(wait).toHaveBeenCalledOnce(); expect(wait).toHaveBeenCalledWith(2000);
  });
  it('continues a different pending slot after failure but never issues an automatic retry', async () => {
    const value = withSlots(initial(), ['PENDING', 'PENDING']);
    const failed = { ...withSlots(value, ['RETRY_REQUIRED', 'PENDING']), error: 'Image failed' };
    const finished = withSlots(value, ['RETRY_REQUIRED', 'SAVED']);
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(failed, { status: 500 })).mockResolvedValueOnce(Response.json(finished));
    vi.stubGlobal('fetch', fetchMock);
    expect((await runPortfolio(value, vi.fn(), () => false)).job.slots[0].status).toBe('RETRY_REQUIRED');
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).action)).toEqual(['advance', 'advance']);
  });
  it('parses blocked progress, advances other pending slots, and never retries blocked work', async () => {
    const value = withSlots(initial(), ['BLOCKED', 'PENDING']);
    const finished = withSlots(value, ['BLOCKED', 'SAVED']);
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(finished)); vi.stubGlobal('fetch', fetchMock);
    const result = await runPortfolio(value, vi.fn(), () => false);
    expect(result.job.slots.map(slot => slot.status)).toEqual(['BLOCKED', 'SAVED']);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).action).toBe('advance');
    expect(result.job.slots[0].error).toContain('smaller video pool');
  });
  it('pauses immediately after quota denial and after a lost network response', async () => {
    const value = initial(), update = vi.fn();
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ ...value, error: 'Quota reached' }, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(runPortfolio(value, update, () => false)).rejects.toThrow('Quota reached');
    expect(update).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockRejectedValueOnce(new Error('Network lost'));
    await expect(runPortfolio(value, update, () => false)).rejects.toThrow('Network lost');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('honors pause after current work and refuses unchanged progress loops', async () => {
    const value = initial(), fetchMock = vi.fn().mockResolvedValueOnce(Response.json(withSlots(value, ['PENDING', 'PENDING'])));
    vi.stubGlobal('fetch', fetchMock); let paused = false;
    await runPortfolio(value, () => { paused = true; }, () => paused);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(Response.json(value));
    await expect(runPortfolio(value, vi.fn(), () => false)).rejects.toThrow('did not advance');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('fails closed on malformed, wrong-job or unsaved creative responses', async () => {
    const value = initial(), saved = withSlots(value, ['SAVED', 'PENDING']);
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ ...value, job: {} }))
      .mockResolvedValueOnce(Response.json(initial()))
      .mockResolvedValueOnce(Response.json({ ...saved, creatives: [{ ...saved.creatives[0], finalization: undefined }] }));
    vi.stubGlobal('fetch', fetchMock);
    for (let index = 0; index < 3; index++) await expect(requestPortfolio({ action: 'load', id: value.job.id })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
