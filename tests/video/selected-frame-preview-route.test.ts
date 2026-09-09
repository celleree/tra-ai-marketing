import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ access: vi.fn(), quota: vi.fn(), available: vi.fn(), previewAvailable: true, hydrate: vi.fn(), hash: vi.fn(), context: vi.fn(), extract: vi.fn() }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.access }));
vi.mock('@/lib/quotas/require-quota', () => ({ requireOperatorQuota: mocks.quota }));
vi.mock('@/lib/video/preview-availability', () => ({ assertDurableVideoIntelligenceAvailable: mocks.available, videoIntelligenceHttpStatus: (status: number) => mocks.previewAvailable ? status : 404 }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: vi.fn(() => ({})) }));
vi.mock('@/lib/media/storage', () => ({ isSafeMediaId: (id: string) => /^media_[a-f0-9]{32}$/.test(id) }));
vi.mock('@/lib/media/source-hydration', () => ({
  CreativeSourceHydrationError: class extends Error { status = 404 as const; }, hydrateCreativeSourceSelections: mocks.hydrate,
}));
vi.mock('@/lib/video/library-service', () => ({ videoSourceHash: mocks.hash }));
vi.mock('@/lib/video/selection-context', () => ({ loadVideoSelectionContext: mocks.context, extractVideoSelectionFrames: mocks.extract }));
import { POST } from '@/app/api/video/intelligence/selected-frame-preview/route';

const mediaId = `media_${'a'.repeat(32)}`;
const frameId = `video-frame:${'b'.repeat(64)}`;
const hash = 'c'.repeat(64);
const libraryId = `video-library:${'d'.repeat(64)}`;
const body = { mediaId, videoFrameSelection: { libraryId, sourceVideoContentHash: hash, frameIds: [frameId] } };
const request = (value: unknown = body) => ({ json: vi.fn().mockResolvedValue(value) }) as unknown as Request;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({ allowed: true, userId: 'operator' }); mocks.quota.mockResolvedValue(null); mocks.available.mockImplementation(() => {}); mocks.previewAvailable = true; mocks.hash.mockReturnValue(hash);
  mocks.hydrate.mockResolvedValue([{ media: { id: mediaId }, stored: { buffer: Buffer.from('source') }, role: 'TRA_VIDEO' }]);
  mocks.context.mockResolvedValue({ library: { id: libraryId } });
  mocks.extract.mockResolvedValue({ frames: [{ buffer: Buffer.from('png'), timestampMs: 500, frameSha256: 'e'.repeat(64) }] });
});
afterEach(() => vi.restoreAllMocks());

describe('selected source-frame PNG preview', () => {
  it('stops at authentication or Preview availability before parsing or downstream work', async () => {
    const denied = { allowed: false, status: 403, error: 'Access denied.' };
    mocks.access.mockResolvedValue(denied); const deniedRequest = request();
    expect((await POST(deniedRequest)).status).toBe(403); expect(deniedRequest.json).not.toHaveBeenCalled();
    mocks.access.mockResolvedValue({ allowed: true, userId: 'operator' }); mocks.previewAvailable = false; mocks.available.mockImplementation(() => { throw new Error('Unavailable'); }); const unavailable = request();
    expect((await POST(unavailable)).status).toBe(404); expect(unavailable.json).not.toHaveBeenCalled(); expect(mocks.hydrate).not.toHaveBeenCalled();
  });

  it.each([{}, { ...body, mediaId: 'unsafe' }, { ...body, videoFrameSelection: { ...body.videoFrameSelection, frameIds: [frameId, `video-frame:${'f'.repeat(64)}`] } }])
  ('rejects an invalid single-frame request before hydration', async (value) => {
    expect((await POST(request(value))).status).toBe(400); expect(mocks.hydrate).not.toHaveBeenCalled();
  });

  it('returns a no-store recovery error for malformed JSON, a missing context, or failed extraction', async () => {
    const malformed = { json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')) } as unknown as Request;
    const malformedResponse = await POST(malformed); expect(malformedResponse.status).toBe(400);
    mocks.context.mockResolvedValue(null); const missing = await POST(request()); expect(missing.status).toBe(409);
    expect(missing.headers.get('cache-control')).toBe('private, no-store'); expect((await missing.json()).error).toContain('library');
    mocks.context.mockResolvedValue({ library: { id: libraryId } }); mocks.extract.mockRejectedValue(new Error('Fresh extraction failed'));
    const failed = await POST(request()); expect(failed.status).toBe(409);
    expect(failed.headers.get('cache-control')).toBe('private, no-store'); expect((await failed.json()).error).toBe('Fresh extraction failed');
  });

  it('rejects stale source or library identity without extraction', async () => {
    mocks.hash.mockReturnValue('f'.repeat(64)); expect((await POST(request())).status).toBe(409); expect(mocks.context).not.toHaveBeenCalled();
    mocks.hash.mockReturnValue(hash); mocks.context.mockResolvedValue({ library: { id: `video-library:${'f'.repeat(64)}` } });
    expect((await POST(request())).status).toBe(409); expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('hydrates the TRA video and returns only the fresh PNG with verification headers', async () => {
    const response = await POST(request());
    expect(mocks.hydrate).toHaveBeenCalledWith(expect.anything(), [{ mediaId, role: 'TRA_VIDEO' }]);
    expect(mocks.extract).toHaveBeenCalledWith(expect.anything(), { library: { id: libraryId } }, [frameId]);
    expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-tra-frame-id')).toBe(frameId); expect(response.headers.get('x-tra-frame-timestamp-ms')).toBe('500');
    expect(response.headers.get('x-tra-png-sha256')).toBe('e'.repeat(64));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from('png'));
  });
});
