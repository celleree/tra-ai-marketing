import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  analyzeCompanyWebsite: vi.fn(), getMediaStorage: vi.fn(), getOperatorAccess: vi.fn(), requireOperatorQuota: vi.fn(),
}));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.getOperatorAccess }));
vi.mock('@/lib/company/website-analyzer', () => ({ analyzeCompanyWebsite: mocks.analyzeCompanyWebsite }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: mocks.getMediaStorage }));
vi.mock('@/lib/quotas/require-quota', () => ({ requireOperatorQuota: mocks.requireOperatorQuota }));

import { POST as analyzeWebsite } from '@/app/api/company/analyze-website/route';
import { POST as analyzeFont } from '@/app/api/company/fonts/analyze/route';

const request = (body: object) => new Request('http://localhost/api/company', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('company analysis quota admission', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getOperatorAccess.mockResolvedValue({ allowed: true, userId: 'operator' });
    mocks.requireOperatorQuota.mockResolvedValue(null);
    mocks.getMediaStorage.mockReturnValue({ readImageById: vi.fn() });
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('preserves successful website and font analysis after admission', async () => {
    mocks.analyzeCompanyWebsite.mockResolvedValue({ summary: 'Company summary' });
    mocks.getMediaStorage.mockReturnValue({ readImageById: vi.fn().mockResolvedValue({ mimeType: 'image/png', buffer: Buffer.from('specimen') }) });
    vi.mocked(fetch).mockResolvedValue(Response.json({ output: [{ content: [{ type: 'output_text', text: 'Geometric sans serif.' }] }] }));
    expect(await (await analyzeWebsite(request({ websiteUrl: 'https://tra.example' }))).json()).toEqual({ summary: 'Company summary' });
    expect(await (await analyzeFont(request({ mediaId: `media_${'a'.repeat(32)}` }))).json()).toEqual({ description: 'Geometric sans serif.' });
    expect(mocks.requireOperatorQuota).toHaveBeenNthCalledWith(1, 'operator', 'WEBSITE_ANALYSIS', 1);
    expect(mocks.requireOperatorQuota).toHaveBeenNthCalledWith(2, 'operator', 'FONT_ANALYSIS', 1);
    expect(mocks.requireOperatorQuota.mock.invocationCallOrder[0]).toBeLessThan(mocks.analyzeCompanyWebsite.mock.invocationCallOrder[0]);
    expect(mocks.requireOperatorQuota.mock.invocationCallOrder[1]).toBeLessThan(mocks.getMediaStorage.mock.invocationCallOrder[0]);
  });

  it('does not reserve font quota when its provider is unconfigured', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    expect((await analyzeFont(request({ mediaId: `media_${'a'.repeat(32)}` }))).status).toBe(503);
    expect(mocks.requireOperatorQuota).not.toHaveBeenCalled();
    expect(mocks.getMediaStorage).not.toHaveBeenCalled();
  });

  it('keeps malformed website and font inputs free', async () => {
    expect((await analyzeWebsite(request({ websiteUrl: '' }))).status).toBe(400);
    expect((await analyzeFont(request({ mediaId: 'bad' }))).status).toBe(400);
    expect(mocks.requireOperatorQuota).not.toHaveBeenCalled();
  });

  it.each([
    ['website', () => analyzeWebsite(request({ websiteUrl: 'https://tra.example' })), 'WEBSITE_ANALYSIS'],
    ['font', () => analyzeFont(request({ mediaId: `media_${'a'.repeat(32)}` })), 'FONT_ANALYSIS'],
  ] as const)('charges one %s analysis unit before expensive work', async (_name, invoke, group) => {
    mocks.requireOperatorQuota.mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '60' } }));
    const response = await invoke();
    expect(response.status).toBe(429);
    expect(mocks.requireOperatorQuota).toHaveBeenCalledWith('operator', group, 1);
    expect(mocks.analyzeCompanyWebsite).not.toHaveBeenCalled();
    expect(mocks.getMediaStorage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([429, 503])('rejects unavailable or exhausted quota before website and font work: %i', async status => {
    mocks.requireOperatorQuota.mockResolvedValue(new Response(null, { status }));
    expect((await analyzeWebsite(request({ websiteUrl: 'https://tra.example' }))).status).toBe(status);
    expect((await analyzeFont(request({ mediaId: `media_${'a'.repeat(32)}` }))).status).toBe(status);
    expect(mocks.analyzeCompanyWebsite).not.toHaveBeenCalled();
    expect(mocks.getMediaStorage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
