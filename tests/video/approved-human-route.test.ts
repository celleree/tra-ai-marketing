import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ access: vi.fn(), quota: vi.fn(), available: vi.fn(), enabled: true,
  list: vi.fn(), approve: vi.fn(), change: vi.fn(), preview: vi.fn() }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.access }));
vi.mock('@/lib/quotas/require-quota', () => ({ requireOperatorQuota: mocks.quota }));
vi.mock('@/lib/video/approved-human-store', () => ({ listApprovedHumanFrames: mocks.list }));
vi.mock('@/lib/video/approved-human-service', () => ({ approveHumanFrame: mocks.approve, changeApprovedHumanActive: mocks.change, readApprovedHumanPreview: mocks.preview }));
vi.mock('@/lib/video/preview-availability', () => ({ assertDurableVideoIntelligenceAvailable: mocks.available, videoIntelligenceHttpStatus: (status: number) => mocks.enabled ? status : 404 }));
import { GET, POST, PATCH } from '@/app/api/video/humans/route';

const id = `human_${'f'.repeat(64)}`;
const body = { mediaId: `media_${'a'.repeat(32)}`, videoFrameSelection: {
  version: 2, libraryId: `video-library:${'b'.repeat(64)}`, sourceVideoContentHash: 'c'.repeat(64), frameIds: [`video-frame:${'d'.repeat(64)}`],
  sourceOverlays: [{ version: 2, status: 'CLEAN' }],
}, previewPngSha256: 'e'.repeat(64), description: 'Approved visible presenter' };
const request = (value?: unknown, query = '') => new Request(`http://localhost/api/video/humans${query}`,
  value === undefined ? undefined : { method: 'POST', body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  vi.resetAllMocks(); mocks.enabled = true; mocks.access.mockResolvedValue({ allowed: true, userId: 'authenticated-operator' });
  mocks.quota.mockResolvedValue(null); mocks.list.mockResolvedValue([{ id }]); mocks.approve.mockResolvedValue({ id });
  mocks.change.mockResolvedValue({ id, active: false }); mocks.preview.mockResolvedValue(Buffer.from('validated-preview'));
});
describe('human library curation API', () => {
  it.each([GET, POST, PATCH])('protects every operation with operator access and video availability', async handler => {
    mocks.access.mockResolvedValue({ allowed: false, status: 403, error: 'Access denied.' });
    expect((await handler(request(body))).status).toBe(403);
    mocks.access.mockResolvedValue({ allowed: true, userId: 'operator' }); mocks.enabled = false;
    mocks.available.mockImplementation(() => { throw new Error('Unavailable'); });
    expect((await handler(request(body))).status).toBe(404);
    expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.approve).not.toHaveBeenCalled(); expect(mocks.change).not.toHaveBeenCalled();
  });
  it('lists metadata and serves only private approved previews', async () => {
    const list = await GET(request()); expect(await list.json()).toEqual({ records: [{ id }] });
    expect(list.headers.get('cache-control')).toBe('private, no-store');
    const preview = await GET(request(undefined, `?preview=${id}`));
    expect(preview.headers.get('content-type')).toBe('image/png'); expect(preview.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.preview).toHaveBeenCalledWith(id);
    expect((await GET(request(undefined, '?preview=bad'))).status).toBe(400);
  });
  it('approves only a valid preview-bound request with server-derived operator identity', async () => {
    expect((await POST(request(body))).status).toBe(200);
    expect(mocks.quota).toHaveBeenCalledWith('authenticated-operator', 'VIDEO_FRAME_PREVIEW', 1);
    expect(mocks.approve).toHaveBeenCalledWith({ mediaId: body.mediaId, selection: body.videoFrameSelection,
      previewPngSha256: body.previewPngSha256, description: body.description }, 'authenticated-operator');
  });
  it.each([{}, { ...body, approvedBy: 'client' }, { ...body, previewPngSha256: '' }, { ...body, description: ' ' },
    { ...body, videoFrameSelection: { ...body.videoFrameSelection, frameIds: [...body.videoFrameSelection.frameIds, `video-frame:${'f'.repeat(64)}`] } }])
  ('rejects malformed approval before quota or extraction', async value => {
    expect((await POST(request(value))).status).toBe(400); expect(mocks.quota).not.toHaveBeenCalled(); expect(mocks.approve).not.toHaveBeenCalled();
  });
  it('checks extraction quota for approval/reactivation but allows cheap deactivation', async () => {
    mocks.quota.mockResolvedValue(new Response('Quota exceeded', { status: 429 }));
    expect((await POST(request(body))).status).toBe(429);
    expect((await PATCH(request({ id, active: true }))).status).toBe(429);
    expect(mocks.approve).not.toHaveBeenCalled(); expect(mocks.change).not.toHaveBeenCalled();
    expect((await PATCH(request({ id, active: false }))).status).toBe(200);
    expect(mocks.change).toHaveBeenCalledExactlyOnceWith(id, false);
  });
  it('returns recoverable source failures and rejects malformed activation/JSON', async () => {
    expect((await PATCH(request({ id, active: 'true' }))).status).toBe(400);
    mocks.change.mockRejectedValue(new Error('Source changed'));
    expect((await PATCH(request({ id, active: true }))).status).toBe(409);
    const malformed = new Request('http://localhost/api/video/humans', { method: 'POST', body: '{' });
    expect((await POST(malformed)).status).toBe(400);
  });
});
