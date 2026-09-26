import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ access: vi.fn(), quota: vi.fn(), hydrate: vi.fn(), hash: vi.fn(),
  context: vi.fn(), preflight: vi.fn(), select: vi.fn(), available: vi.fn() }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.access }));
vi.mock('@/lib/quotas/require-quota', () => ({ requireOperatorQuota: mocks.quota }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: () => ({}) }));
vi.mock('@/lib/media/source-hydration', () => ({ hydrateCreativeSourceSelections: mocks.hydrate,
  CreativeSourceHydrationError: class CreativeSourceHydrationError extends Error { status = 404; } }));
vi.mock('@/lib/video/library-service', () => ({ videoSourceHash: mocks.hash }));
vi.mock('@/lib/video/selection-context', () => ({ loadVideoSelectionContext: mocks.context }));
vi.mock('@/lib/video/preview-availability', () => ({ assertDurableVideoIntelligenceAvailable: mocks.available,
  videoIntelligenceHttpStatus: (status: number) => status }));
vi.mock('@/lib/video/selection-cache', () => ({ preflightVideoHumanFrameFromPoolWithCache: mocks.preflight,
  selectVideoHumanFrameFromPoolWithCache: mocks.select }));
import { POST } from '@/app/api/video/intelligence/source-overlay-assessment/route';

const mediaId = `media_${'a'.repeat(32)}`;
const libraryId = `video-library:${'b'.repeat(64)}`;
const frameIds = [`video-frame:${'c'.repeat(64)}`, `video-frame:${'d'.repeat(64)}`];
const hash = 'e'.repeat(64);
const selection = { libraryId, sourceVideoContentHash: hash, frameIds };
const request = (value: unknown = { mediaId, videoFrameSelection: selection }) => new Request('http://localhost/api/video/intelligence/source-overlay-assessment',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const assessment = (frameId: string, sourceOverlay: object = { version: 2, status: 'CLEAN' }) => ({
  libraryId, frameId, humanPresence: 'CLEAR', facialDetail: 'SUFFICIENT', eyes: 'OPEN_OR_NOT_VISIBLE',
  blur: 'CLEAR', occlusion: 'NONE_OR_MINOR', expressionUsability: 'NATURAL_OR_NEUTRAL',
  framing: 'USABLE', compositionFit: 'ACCEPTABLE', sourceOverlay,
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({ allowed: true, userId: 'operator' }); mocks.quota.mockResolvedValue(null);
  mocks.hydrate.mockResolvedValue([{ role: 'TRA_VIDEO', media: { id: mediaId } }]); mocks.hash.mockReturnValue(hash);
  mocks.context.mockResolvedValue({ library: { id: libraryId, representativeFrames: frameIds.map(id => ({ id })) },
    librarySha256: 'f'.repeat(64), representativeImages: [{ frameId: frameIds[0] }] });
  mocks.preflight.mockResolvedValue({ status: 'COMPLETE', outcome: { status: 'SELECTED',
    assessments: frameIds.map(id => assessment(id)) } });
});
describe('explicit source-overlay assessment producer', () => {
  it('binds cached CLEAN and EDGE_CROP decisions to the exact selected frame order without another paid call', async () => {
    mocks.preflight.mockResolvedValue({ status: 'COMPLETE', outcome: { status: 'SELECTED', assessments: [
      assessment(frameIds[0], { version: 2, status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 200, overlayDepthPermille: 180 }),
      assessment(frameIds[1]),
    ] } });
    const response = await POST(request({ mediaId, videoFrameSelection: { ...selection, frameIds: [...frameIds].reverse() } }));
    expect(response.status).toBe(200);
    expect((await response.json()).videoFrameSelection).toMatchObject({ version: 2, frameIds: [...frameIds].reverse(),
      sourceOverlays: [{ version: 2, status: 'CLEAN' }, { version: 2, status: 'EDGE_CROP', edge: 'BOTTOM' }] });
    expect(mocks.quota).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled();
  });
  it('admits one existing visual-contract call on cache miss and fails closed on unsafe or stale selection', async () => {
    mocks.preflight.mockResolvedValue({ status: 'READY' });
    mocks.select.mockResolvedValue({ status: 'COMPLETE', outcome: { status: 'SELECTED', assessments: frameIds.map(id => assessment(id)) } });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.quota).toHaveBeenCalledExactlyOnceWith('operator', 'VIDEO_SELECTION', 1);
    expect(mocks.select).toHaveBeenCalledOnce();
    mocks.preflight.mockResolvedValue({ status: 'COMPLETE', outcome: { status: 'NO_SUITABLE_HUMAN', assessments: [
      assessment(frameIds[0], { version: 2, status: 'UNSAFE' }), assessment(frameIds[1]),
    ] } });
    expect((await POST(request())).status).toBe(409);
    expect(mocks.select).toHaveBeenCalledOnce();
    mocks.hash.mockReturnValue('0'.repeat(64));
    expect((await POST(request())).status).toBe(409);
    expect(mocks.preflight).toHaveBeenCalledTimes(2);
  });
  it('requires an explicit retry after a cached uncertain assessment', async () => {
    mocks.preflight.mockResolvedValue({ status: 'READY' });
    mocks.select.mockResolvedValue({ status: 'RETRY_REQUIRED', reason: 'PROVIDER_FAILED' });
    const first = await POST(request());
    expect(first.status).toBe(409);
    expect((await first.json()).retryRequired).toBe(true);
    expect(mocks.select.mock.calls[0][3].retry).toBe(false);
    const retried = await POST(request({ mediaId, videoFrameSelection: selection, retry: true }));
    expect(retried.status).toBe(409);
    expect(mocks.select.mock.calls[1][3].retry).toBe(true);
  });
});
