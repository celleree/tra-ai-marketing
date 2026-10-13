import { beforeEach, describe, expect, it, vi } from 'vitest';
import { videoCasePortfolio } from '../fixtures/video-case-portfolio';
const mocks = vi.hoisted(() => ({ access: vi.fn(), read: vi.fn(), apply: vi.fn() }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.access }));
vi.mock('@/lib/creatives/portfolio-job-storage', () => ({ readCreativePortfolio: mocks.read }));
vi.mock('@/lib/creatives/portfolio-case-amendment-storage', () => ({ applyCaseAmendment: mocks.apply }));
import { GET, POST, PATCH } from '@/app/api/creatives/portfolios/case-amendment/route';
import { proposeCaseAmendment } from '@/lib/creatives/portfolio-case-amendment';
let fixture: ReturnType<typeof videoCasePortfolio>;
const request = (method: string, body?: unknown) => new Request(`http://localhost/api/creatives/portfolios/case-amendment?id=${fixture.job.id}`, {
  method, ...(body ? { body: JSON.stringify(body) } : {}) });
beforeEach(() => { vi.resetAllMocks(); fixture = videoCasePortfolio();
  mocks.access.mockResolvedValue({ allowed: true, userId: 'operator' }); mocks.read.mockResolvedValue(fixture.job); });
describe('case amendment operator boundary', () => {
  it('loads source choices and proposes without saving or advancing', async () => {
    const original = structuredClone(fixture.job);
    expect((await GET(request('GET'))).status).toBe(200);
    const response = await POST(request('POST', { id: fixture.job.id, pairs: fixture.pairs }));
    expect(response.status).toBe(200); expect((await response.json()).creatives[1].imageCopy.shortSupport).toBe(fixture.segments[1].text);
    expect(mocks.apply).not.toHaveBeenCalled(); expect(fixture.job).toEqual(original);
  });
  it.each([401, 403, 503])('denies %s before any saved source read or write', async status => {
    mocks.access.mockResolvedValue({ allowed: false, status, error: 'Denied' });
    for (const [method, handler] of [['GET', GET], ['POST', POST], ['PATCH', PATCH]] as const) {
      expect((await handler(request(method, method === 'GET' ? undefined : { id: fixture.job.id, pairs: fixture.pairs }))).status).toBe(status);
    }
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('only explicitly applies an amendment; rejects hidden generation actions and extra inputs', async () => {
    const amendment = proposeCaseAmendment(fixture.job, fixture.pairs).amendment;
    mocks.apply.mockResolvedValue({ ...fixture.job, videoCaseAmendment: amendment });
    expect((await PATCH(request('PATCH', { id: fixture.job.id, amendment }))).status).toBe(200);
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(fixture.job.id, amendment);
    mocks.apply.mockClear();
    for (const body of [{ id: fixture.job.id, amendment, advance: true }, { id: fixture.job.id, action: 'advance' }]) {
      expect((await PATCH(request('PATCH', body))).status).toBe(400);
    }
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('does not expose storage exceptions and never turns a rejected save into a provider retry', async () => {
    mocks.apply.mockRejectedValue(new Error('private credential-bearing storage detail'));
    const response = await PATCH(request('PATCH', { id: fixture.job.id, amendment: {} }));
    expect(response.status).toBe(409); expect(JSON.stringify(await response.json())).not.toContain('private credential');
  });
});
