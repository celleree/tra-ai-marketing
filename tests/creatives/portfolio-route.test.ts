import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newCreativePortfolio, type CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';
const mocks = vi.hoisted(() => ({ access: vi.fn(), create: vi.fn(), read: vi.fn(), update: vi.fn(), advance: vi.fn(), creatives: vi.fn() }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.access }));
vi.mock('@/lib/creatives/portfolio-job-storage', () => ({
  createCreativePortfolio: mocks.create, readCreativePortfolio: mocks.read, updateCreativePortfolio: mocks.update,
}));
vi.mock('@/lib/creatives/portfolio-execution', () => ({ advanceCreativePortfolio: mocks.advance }));
vi.mock('@/lib/creatives/portfolio-results', () => ({ readPortfolioCreatives: mocks.creatives }));
import { GET, POST, PATCH } from '@/app/api/creatives/portfolios/route';
let job: CreativePortfolioJob;
afterEach(() => { vi.unstubAllEnvs(); });
const request = (body?: unknown, id?: string) => new Request('http://localhost/api/creatives/portfolios' + (id ? '?id=' + id : ''),
  body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json',
    'Idempotency-Key': '11111111-1111-4111-8111-111111111111' } });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('OPENAI_API_KEY', 'fixture');
  job = newCreativePortfolio(portfolioRequest());
  mocks.access.mockResolvedValue({ allowed: true, userId: 'signed-in-operator' });
  mocks.read.mockImplementation(async () => job);
  mocks.create.mockImplementation(async input => newCreativePortfolio(input));
  mocks.update.mockImplementation(async (_id, change) => { job = change(job); return job; });
  mocks.advance.mockImplementation(async () => ({ job }));
  mocks.creatives.mockResolvedValue([]);
});

describe('resumable portfolio API', () => {
  it.each([GET, POST, PATCH])('requires operator authorization before any job work', async handler => {
    mocks.access.mockResolvedValue({ allowed: false, status: 403, error: 'Denied' });
    const response = await handler(request({ id: job.id, action: 'advance' }, job.id));
    expect(response.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.advance).not.toHaveBeenCalled();
  });
  it('creates 36 stable slots without advancing paid work and preserves the normalized request privately', async () => {
    const response = await POST(request(portfolioRequest(36)));
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body.job.slots).toHaveLength(36);
    expect(body.job.planReady).toBe(false);
    expect(body.job).not.toHaveProperty('request');
    expect(mocks.create.mock.calls[0][0].context).toContain('USER CREATIVE DIRECTION:');
    expect(mocks.advance).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0][3]).toEqual({ operatorId: 'signed-in-operator', id: '11111111-1111-4111-8111-111111111111' });
    expect((await POST(request(portfolioRequest(37)))).status).toBe(400);
  });
  it('rejects missing submission identity before creating work', async () => {
    const input = request(portfolioRequest()); input.headers.delete('Idempotency-Key');
    expect((await POST(input)).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.advance).not.toHaveBeenCalled();
  });
  it('returns saved progress without disclosing broad context or the internal lease token', async () => {
    job.snapshot = portfolioSnapshot(job); job.lease = { id: 'private-token', slotIndex: 1, expiresAtMs: Date.now() + 10000 };
    const body = await (await GET(request(undefined, job.id))).json();
    expect(body.job).toMatchObject({ id: job.id, planReady: true, lease: { slotIndex: 1 } });
    expect(body.job).not.toHaveProperty('snapshot'); expect(body.job.lease).not.toHaveProperty('id');
    expect(mocks.advance).not.toHaveBeenCalled();
    mocks.read.mockResolvedValue(null);
    expect((await GET(request(undefined, job.id))).status).toBe(404);
  });
  it('advances one unit with the authenticated operator identity and preserves quota headers/progress', async () => {
    mocks.advance.mockResolvedValue({ job, status: 429, error: 'Quota reached', retryAfterSeconds: 90 });
    const response = await PATCH(request({ id: job.id, action: 'advance', operatorId: 'client-value' }));
    expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('90');
    expect(mocks.advance).toHaveBeenCalledExactlyOnceWith(job.id, 'signed-in-operator',
      'http://localhost/api/creatives/portfolios', undefined, { deadlineAtMs: expect.any(Number) });
    expect((await response.json()).job.id).toBe(job.id);
  });
  it('only clears explicit retryable work; retry alone never starts provider work', async () => {
    expect((await PATCH(request({ id: job.id, action: 'retry', slotIndex: null }))).status).toBe(409);
    job.planningError = 'Interrupted';
    const response = await PATCH(request({ id: job.id, action: 'retry', slotIndex: null }));
    expect(response.status).toBe(200);
    expect((await response.json()).job.planningError).toBeNull();
    expect(mocks.advance).not.toHaveBeenCalled();
  });
  it('refuses to reset a blocked creative', async () => {
    job.snapshot = portfolioSnapshot(job);
    job.planning = { phase: 'READY_TO_RENDER' };
    job.slots[0] = { ...job.slots[0], status: 'BLOCKED', error: 'Create a new portfolio with a smaller video pool.' };
    const reopened = await (await GET(request(undefined, job.id))).json();
    expect(reopened.job.slots[0].status).toBe('BLOCKED');
    expect((await PATCH(request({ id: job.id, action: 'retry', slotIndex: 1 }))).status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.advance).not.toHaveBeenCalled();
  });
  it.each([null, {}, { id: 'bad', action: 'advance' }, { action: 'unknown' }, { action: 'retry' },
    { action: 'retry', slotIndex: 37 }, { action: 'advance', slotIndex: 1 }])('rejects malformed action %j before execution', async input => {
    const body = input === null ? null : { id: job.id, ...input };
    expect((await PATCH(request(body))).status).toBe(400);
    expect(mocks.advance).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
});
