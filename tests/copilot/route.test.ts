import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreativeRecord } from '@/lib/creatives/generated';
const mocks = vi.hoisted(() => ({ getOperatorAccess: vi.fn(), listCreatives: vi.fn(), requireOperatorQuota: vi.fn(), requestClaudeCopilot: vi.fn() }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.getOperatorAccess }));
vi.mock('@/lib/quotas/require-quota', () => ({ requireOperatorQuota: mocks.requireOperatorQuota }));
vi.mock('@/lib/creatives/storage', async original => ({ ...await original<typeof import('@/lib/creatives/storage')>(), listCreatives: mocks.listCreatives }));
vi.mock('@/lib/copilot/claude', async original => ({ ...await original<typeof import('@/lib/copilot/claude')>(), requestClaudeCopilot: mocks.requestClaudeCopilot }));
import { CLAUDE_COPILOT_MODEL, ClaudeCopilotError } from '@/lib/copilot/claude';
import { GET, POST } from '@/app/api/copilot/recommendations/route';

const id = `creative_${'a'.repeat(32)}`;
const saved: CreativeRecord = { id, createdAt: '2026-10-11T12:00:00Z', category: 'customer-problems',
  image: { id: `media_${'b'.repeat(32)}`, fileName: `media_${'b'.repeat(32)}.png`, originalName: 'saved.png', mimeType: 'image/png', size: 10, url: '/private.png' },
  copy: { primaryText: 'Saved primary', headline: 'Saved headline', description: '' },
  identity: { conceptId: id, parentCreativeId: null, operation: 'GENERATE', fingerprint: 'c'.repeat(64) } };
const input = () => ({ creativeId: id, companyProfile: { knowledgeBase: { companySummary: 'Explicitly approved services' } }, companyContextApproved: true, allowPaidRequest: true });
const request = (value: unknown = input()) => new Request('http://localhost/api/copilot/recommendations', { method: 'POST', body: JSON.stringify(value) });
const response = async (result: Response, status: number) => {
  expect(result.status).toBe(status); expect(result.headers.get('Cache-Control')).toBe('private, no-store'); return result.json();
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TRA_CLAUDE_COPILOT_ENABLED', 'true'); vi.stubEnv('TRA_CLAUDE_COPILOT_ALLOW_PAID', 'true'); vi.stubEnv('ANTHROPIC_API_KEY', 'offline-key');
  mocks.getOperatorAccess.mockResolvedValue({ allowed: true, userId: 'server-operator' });
  mocks.listCreatives.mockResolvedValue([saved]); mocks.requireOperatorQuota.mockResolvedValue(null);
  mocks.requestClaudeCopilot.mockResolvedValue({ action: 'DO_NOTHING', performance: 'unknown' });
});
afterEach(() => vi.unstubAllEnvs());

describe('operator-only Claude recommendation route (offline)', () => {
  it.each([401, 403, 503])('gates GET and POST before reading the body or invoking storage/quota/provider: %i', async status => {
    mocks.getOperatorAccess.mockResolvedValue({ allowed: false, status, error: 'Access unavailable' });
    const readBody = vi.fn(() => { throw new Error('body must not be read'); });
    const deniedRequest = Object.defineProperty({}, 'body', { get: readBody }) as Request;
    await response(await GET(), status); await response(await POST(deniedRequest), status);
    expect(readBody).not.toHaveBeenCalled(); expect(mocks.listCreatives).not.toHaveBeenCalled();
    expect(mocks.requireOperatorQuota).not.toHaveBeenCalled(); expect(mocks.requestClaudeCopilot).not.toHaveBeenCalled();
  });
  it('reports authenticated availability without secrets or storage/provider calls', async () => {
    expect(await response(await GET(), 200)).toEqual({ available: true, model: CLAUDE_COPILOT_MODEL });
    expect(mocks.listCreatives).not.toHaveBeenCalled(); expect(mocks.requireOperatorQuota).not.toHaveBeenCalled(); expect(mocks.requestClaudeCopilot).not.toHaveBeenCalled();
  });
  it.each(['TRA_CLAUDE_COPILOT_ENABLED', 'TRA_CLAUDE_COPILOT_ALLOW_PAID', 'ANTHROPIC_API_KEY'])('fails closed with missing %s before POST effects', async name => {
    vi.stubEnv(name, '');
    expect(await response(await GET(), 200)).toEqual({ available: false, model: CLAUDE_COPILOT_MODEL });
    await response(await POST(request()), 503);
    expect(mocks.listCreatives).not.toHaveBeenCalled(); expect(mocks.requireOperatorQuota).not.toHaveBeenCalled(); expect(mocks.requestClaudeCopilot).not.toHaveBeenCalled();
  });
  it.each([{ ...input(), allowPaidRequest: false }, { ...input(), allowPaidRequest: 'true' }, { ...input(), model: 'client-model' },
    { ...input(), copy: saved.copy }, { ...input(), identity: saved.identity }, { ...input(), maxOutputTokens: 100 }, [], null,
    { ...input(), creativeId: '../bad' }, { ...input(), companyProfile: 'not a profile' }])('rejects unsupported/invalid requests before effects', async value => {
    await response(await POST(request(value)), 400);
    expect(mocks.listCreatives).not.toHaveBeenCalled(); expect(mocks.requireOperatorQuota).not.toHaveBeenCalled(); expect(mocks.requestClaudeCopilot).not.toHaveBeenCalled();
  });
  it('requires explicit company approval before loading saved creative or charging quota', async () => {
    const body = await response(await POST(request({ ...input(), companyContextApproved: false })), 400);
    expect(body.error).toContain('Approve the effective company context');
    expect(mocks.listCreatives).not.toHaveBeenCalled(); expect(mocks.requireOperatorQuota).not.toHaveBeenCalled(); expect(mocks.requestClaudeCopilot).not.toHaveBeenCalled();
  });
  it.each(['not json', 'x'.repeat(256 * 1024 + 1), JSON.stringify({ ...input(), companyProfile: { knowledgeBase: { companySummary: '界'.repeat(100000) } } })])('bounds raw body bytes and rejects malformed JSON', async body => {
    await response(await POST(new Request('http://localhost/api/copilot/recommendations', { method: 'POST', body })), 400);
    expect(mocks.listCreatives).not.toHaveBeenCalled(); expect(mocks.requestClaudeCopilot).not.toHaveBeenCalled();
  });
  it.each([{ records: [] }, { records: [{ ...saved, identity: undefined }] }])('rejects missing or identity-less saved creatives without paid work', async ({ records }) => {
    mocks.listCreatives.mockResolvedValue(records); await response(await POST(request()), 404);
    expect(mocks.requireOperatorQuota).not.toHaveBeenCalled(); expect(mocks.requestClaudeCopilot).not.toHaveBeenCalled();
  });
  it.each([429, 503])('returns quota denial/unavailability before provider work: %i', async status => {
    mocks.requireOperatorQuota.mockResolvedValue(Response.json({ error: 'Quota unavailable' }, { status, headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '60' } }));
    const result = await POST(request()); await response(result, status);
    expect(mocks.requireOperatorQuota).toHaveBeenCalledWith('server-operator', 'COPILOT_RECOMMENDATION', 1);
    expect(result.headers.get('Retry-After')).toBe('60'); expect(mocks.requestClaudeCopilot).not.toHaveBeenCalled();
  });
  it('makes exactly one fixed-model adapter request using server-loaded evidence and the request signal', async () => {
    const req = request(); const body = await response(await POST(req), 200);
    expect(body.recommendation).toEqual({ action: 'DO_NOTHING', performance: 'unknown' });
    expect(mocks.listCreatives).toHaveBeenCalledTimes(1); expect(mocks.requireOperatorQuota).toHaveBeenCalledTimes(1);
    expect(mocks.requestClaudeCopilot).toHaveBeenCalledTimes(1);
    const [context, options] = mocks.requestClaudeCopilot.mock.calls[0];
    expect(context.creatives[0].evidence.adCopy).toEqual(saved.copy); expect(context.creatives[0].identity).toEqual(saved.identity);
    expect(context.company.approvedText).toContain('Explicitly approved services'); expect(context.performance).toBe('unknown');
    expect(options).toEqual({ apiKey: 'offline-key', allowPaidRequest: true, maxOutputTokens: 4096, signal: req.signal });
    expect(mocks.requireOperatorQuota.mock.invocationCallOrder[0]).toBeLessThan(mocks.requestClaudeCopilot.mock.invocationCallOrder[0]);
  });
  it.each([new ClaudeCopilotError('provider_error', 429), new ClaudeCopilotError('invalid_response'), new Error('secret offline-key provider body')])('redacts provider failures and never retries', async error => {
    mocks.requestClaudeCopilot.mockRejectedValue(error);
    const body = await response(await POST(request()), 503);
    expect(JSON.stringify(body)).not.toMatch(/offline-key|secret|429|provider body/); expect(mocks.requestClaudeCopilot).toHaveBeenCalledTimes(1);
  });
  it('redacts storage/quota exceptions and returns clear oversized provider-context failure', async () => {
    mocks.listCreatives.mockRejectedValueOnce(new Error('secret storage'));
    expect(JSON.stringify(await response(await POST(request()), 503))).not.toContain('secret');
    mocks.requireOperatorQuota.mockRejectedValueOnce(new Error('secret quota'));
    await response(await POST(request()), 503); expect(mocks.requestClaudeCopilot).not.toHaveBeenCalled();
    mocks.requestClaudeCopilot.mockRejectedValueOnce(new ClaudeCopilotError('invalid_input'));
    await response(await POST(request()), 400); expect(mocks.requestClaudeCopilot).toHaveBeenCalledTimes(1);
  });
});
