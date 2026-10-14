import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newCreativePortfolio, type CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';
const mocks = vi.hoisted(() => ({ access: vi.fn(), create: vi.fn(), initialize: vi.fn(), read: vi.fn(), update: vi.fn(), advance: vi.fn(), creatives: vi.fn(), recover: vi.fn(), recoverySlot: vi.fn() }));
vi.mock('@/lib/creatives/portfolio-bound-case-recovery', () => ({ recoverBoundCaseCrop: mocks.recover, boundCaseCropRecoverySlot: mocks.recoverySlot }));
vi.mock('@/lib/creatives/preview-test-initialization', () => ({ initializeApprovedPreviewPortfolio: mocks.initialize }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.access }));
vi.mock('@/lib/creatives/portfolio-job-storage', () => ({
  createCreativePortfolio: mocks.create, readCreativePortfolio: mocks.read, updateCreativePortfolio: mocks.update,
}));
vi.mock('@/lib/creatives/portfolio-execution', () => ({ advanceCreativePortfolio: mocks.advance }));
vi.mock('@/lib/creatives/portfolio-results', () => ({ readPortfolioCreatives: mocks.creatives }));
vi.mock('@/lib/creatives/preview-advance-fence', async original => ({
  ...await original<typeof import('@/lib/creatives/preview-advance-fence')>(), previewAdvanceReadback: async (job: CreativePortfolioJob) => job,
}));
import { GET, POST, PATCH } from '@/app/api/creatives/portfolios/route';
import * as previewApproval from '@/lib/creatives/preview-test-approval';
let job: CreativePortfolioJob;
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
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
  it('advertises a recovery candidate only in Preview without preparing or advancing it', async () => {
    job.snapshot = portfolioSnapshot(job); job.planning = { phase: 'READY_TO_RENDER' };
    job.slots[0].status = 'SAVED'; job.slots[1].status = 'BLOCKED'; job.slots[1].error = 'No suitable human frame was found.';
    mocks.recoverySlot.mockReturnValue(2); vi.stubEnv('VERCEL_ENV', 'preview');
    expect(await (await GET(request(undefined, job.id))).json()).toHaveProperty('boundCaseCropRecoverySlot', 2);
    expect(mocks.recover).not.toHaveBeenCalled(); expect(mocks.advance).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(await (await GET(request(undefined, job.id))).json()).not.toHaveProperty('boundCaseCropRecoverySlot');
  });
  it('prepares failed bound-frame recovery only in Preview, with authentication and no advance', async () => {
    const body = { id: job.id, action: 'recover-bound-case-crop', slotIndex: 2 };
    vi.stubEnv('VERCEL_ENV', 'production'); expect((await PATCH(request(body))).status).toBe(409);
    expect(mocks.recover).not.toHaveBeenCalled();
    vi.stubEnv('VERCEL_ENV', 'preview'); mocks.recover.mockResolvedValue(job);
    expect((await PATCH(request(body))).status).toBe(200);
    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith(job.id, 2); expect(mocks.advance).not.toHaveBeenCalled();
    mocks.recover.mockClear(); mocks.access.mockResolvedValue({ allowed: false, status: 401, error: 'Sign in' });
    expect((await PATCH(request(body))).status).toBe(401); expect(mocks.recover).not.toHaveBeenCalled();
  });
  it('rejects hidden generation inputs on explicit crop recovery', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect((await PATCH(request({ id: job.id, action: 'recover-bound-case-crop', slotIndex: 2, advance: true }))).status).toBe(400);
    expect(mocks.recover).not.toHaveBeenCalled(); expect(mocks.advance).not.toHaveBeenCalled();
  });
  it('offers the visible initialization action only on the exact stopped Preview source without mutating it', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview'); vi.stubEnv('TRA_IMAGE_PURPOSE', 'staging-smoke');
    job.id = previewApproval.PREVIEW_TEST_APPROVAL.previousPortfolioId;
    expect(await (await GET(request(undefined, job.id))).json()).not.toHaveProperty('previewInitializationAvailable');
    job.previewAcceptanceError = 'Prior frame assessment stopped';
    expect(await (await GET(request(undefined, job.id))).json()).toHaveProperty('previewInitializationAvailable', true);
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(await (await GET(request(undefined, job.id))).json()).not.toHaveProperty('previewInitializationAvailable');
    vi.stubEnv('VERCEL_ENV', 'preview'); job.id = 'portfolio_' + 'f'.repeat(32);
    expect(await (await GET(request(undefined, job.id))).json()).not.toHaveProperty('previewInitializationAvailable');
    expect(mocks.initialize).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.advance).not.toHaveBeenCalled();
  });
  it('keeps an approved terminal stop visible on GET after a slot is saved, without doing work', async () => {
    job.snapshot = portfolioSnapshot(job); job.planning = { phase: 'READY_TO_RENDER' }; job.slots[0].status = 'SAVED';
    job.previewAcceptanceError = 'Approved test stopped after an unknown outcome.';
    vi.spyOn(previewApproval, 'isApprovedPreviewPortfolio').mockReturnValue(true);
    const value = await (await GET(request(undefined, job.id))).json();
    expect(value).toMatchObject({ previewPreparationApproved: true, job: { previewAcceptanceError: job.previewAcceptanceError } });
    expect(value.job).not.toHaveProperty('previewPreparationResume');
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.advance).not.toHaveBeenCalled();
  });
  it('preserves a saved preparation failure on read without offering Resume or doing work', async () => {
    job.planningError = 'Prior preparation failure';
    vi.spyOn(previewApproval, 'isApprovedPreviewPortfolio').mockReturnValue(true);
    const value = await (await GET(request(undefined, job.id))).json();
    expect(value).toMatchObject({ previewPreparationApproved: true,
      job: { planningError: 'Prior preparation failure' } });
    expect(value.job).not.toHaveProperty('previewPreparationResume');
    expect(job.planningError).toBe('Prior preparation failure');
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.advance).not.toHaveBeenCalled();
  });
  it('initializes only the fixed approved copy through the authenticated action without advancing work', async () => {
    const body = { action: 'initialize-approved-preview', sourcePortfolioId: 'preserved-source' };
    mocks.initialize.mockResolvedValue(job);
    expect((await POST(request({ ...body, context: 'changed' }))).status).toBe(400);
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect((await POST(request(body))).status).toBe(201);
    expect(mocks.initialize).toHaveBeenCalledExactlyOnceWith('preserved-source');
    mocks.initialize.mockClear(); mocks.access.mockResolvedValue({ allowed: false, status: 403, error: 'Denied' });
    expect((await POST(request(body))).status).toBe(403);
    expect(mocks.initialize).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.advance).not.toHaveBeenCalled();
  });
  it('reports the frozen no-logo test choice on reload without advancing paid work', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview'); vi.stubEnv('TRA_IMAGE_PURPOSE', 'staging-smoke');
    job.request.previewOmitBrandLogo = true; delete job.request.brandLogoMediaId;
    if (job.planning.phase !== 'INITIAL_PLAN') throw new Error('Fixture');
    job.planning.preparation.previewPreflightReady = true;
    const value = await (await GET(request(undefined, job.id))).json();
    expect(value).toMatchObject({ previewOmitBrandLogo: true });
    expect(value).not.toHaveProperty('preflightReady');
    expect(mocks.advance).not.toHaveBeenCalled();
  });
  it('keeps the QA checkpoint/retry restriction while ordinary Preview Create uses normal validation', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview'); vi.stubEnv('TRA_IMAGE_PURPOSE', 'staging-smoke');
    if (job.planning.phase !== 'INITIAL_PLAN') throw new Error('Fixture phase');
    job.planning.preparation.previewPreflightReady = true;
    job.id = previewApproval.PREVIEW_TEST_APPROVAL.portfolioId;
    vi.spyOn(previewApproval, 'isApprovedPreviewPortfolio').mockReturnValue(true);
    expect(await (await GET(request(undefined, job.id))).json()).toHaveProperty('preflightReady', true);
    job.planningError = 'Failed work';
    expect((await PATCH(request({ id: job.id, action: 'retry', slotIndex: null }))).status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
    const response = await POST(request({ ...portfolioRequest(3), context: 'A new ordinary user prompt' }));
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledOnce(); expect(mocks.advance).not.toHaveBeenCalled();
    expect((await response.json()).job.requestedCount).toBe(3);
  });
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
