import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestPortfolio, runPortfolio, type PortfolioResponse } from '@/lib/creatives/portfolio-client';
import { portfolioProgress } from '@/lib/creatives/portfolio-progress';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { portfolioRequest } from '../fixtures/creative-portfolio';

const initial = (): PortfolioResponse => ({ job: portfolioProgress(newCreativePortfolio(portfolioRequest())), creatives: [] });
const withSlots = (value: PortfolioResponse, statuses: Array<'PENDING' | 'SAVED' | 'RETRY_REQUIRED'>): PortfolioResponse => ({
  job: { ...value.job, planReady: true, planningPhase: 'READY_TO_RENDER', lease: null,
    slots: value.job.slots.map((slot, index) => ({ ...slot, status: statuses[index] })) },
  creatives: value.job.slots.filter((_, index) => statuses[index] === 'SAVED').map(slot => ({
    id: slot.creativeId, index: slot.index, category: 'customer-problems', format: 'direct-response',
    copy: { headline: 'Headline', primaryText: 'Copy', description: '' },
    image: { id: 'media_' + 'a'.repeat(32), fileName: 'saved.png', originalName: 'saved.png', mimeType: 'image/png', size: 100, url: '/saved.png' },
    finalization: { status: 'SAVED', createdAt: '2026-09-11T00:00:00.000Z' },
  })),
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('resumable portfolio browser controller', () => {
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
    expect(wait).toHaveBeenCalledOnce();
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
