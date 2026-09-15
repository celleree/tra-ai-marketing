import { beforeEach, describe, expect, it, vi } from 'vitest';
import { portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { renderPlannedCreative } from '@/lib/creatives/render-planned';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), saveBatch: vi.fn(), validate: vi.fn() }));
vi.mock('@/lib/ai/video-frame-generation', () => ({ generateApprovedTraVideoFrameCreativeImage: mocks.generate }));
vi.mock('@/lib/creatives/generated-image-validation', () => ({ validateGeneratedCreativeImage: mocks.validate }));
vi.mock('@/lib/creatives/storage', () => ({ saveCreativeBatch: mocks.saveBatch }));

const mediaId = `media_${'a'.repeat(32)}`, sourceHash = 'b'.repeat(64), frameId = `video-frame:${'c'.repeat(64)}`;
const provenance = [{ frameIndex: 0, libraryFrameId: frameId, candidateFrameSha256: 'd'.repeat(64),
  timestampMs: 1200, approvedPngSha256: 'e'.repeat(64) }];
const frame = { frameIndex: 0, timestampMs: 1200, mimeType: 'image/png', buffer: Buffer.from('png'),
  frameSha256: 'e'.repeat(64), byteLength: 3, sourceRole: 'TRA_VIDEO', sourceVideoMediaId: mediaId,
  sourceVideoFileName: 'source.mp4', sourceVideoContentHash: sourceHash, approvedHumanSource: true, cacheKey: null } as any;
const selection = { libraryId: `video-library:${'f'.repeat(64)}`, sourceVideoMediaId: mediaId,
  sourceVideoContentHash: sourceHash, frames: provenance };
const routing = { operationType: 'TRA_VIDEO_FRAME_GENERATION', preferredModel: 'gpt-image-2.5-sunburst',
  actualModel: 'gpt-image-2.5-sunburst', fallbackUsed: false, fallbackFromModel: null, fallbackReason: null } as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generate.mockResolvedValue({ buffer: Buffer.from('image'), prompt: 'prompt', model: 'gpt-image-2.5-sunburst', routing,
    providerFrames: [frame] });
  mocks.saveBatch.mockImplementation(async records => records.map((record: object) => ({ ...record, createdAt: '2026-09-14T00:00:00.000Z' })));
});

async function render(explicit = false) {
  const request = { ...portfolioRequest(), sourceAssets: [{ role: 'TRA_VIDEO', mediaId }],
    ...(explicit ? { videoFrameSelection: { libraryId: selection.libraryId, sourceVideoContentHash: sourceHash, frameIds: [frameId] } } : {}) } as any;
  const snapshot = portfolioSnapshot(newCreativePortfolio(request));
  return renderPlannedCreative(snapshot.batchPlan.creatives[0], {
    request, batchPlan: snapshot.batchPlan, referenceCatalog: [], selectedReferences: [], requestedSources: [], analysisSources: [],
    reserveLogoArea: false, brandLogo: null, providerImageSource: undefined,
    videoFrameSet: { source: {} as any, sourceVideoContentHash: sourceHash, durationMs: 2000, reused: false, frames: [frame] },
    generatedVideoFrameSelection: selection,
    storage: { saveImage: vi.fn().mockResolvedValue({ id: `media_${'1'.repeat(32)}`, fileName: 'creative.png', originalName: 'creative.png',
      mimeType: 'image/png', size: 5, url: '/creative.png' }) } as any,
  }, { creativeId: `creative_${'2'.repeat(32)}` });
}

describe('render planned video provenance', () => {
  it('saves automatic B3 provenance with exact selected-frame evidence', async () => {
    const creative = await render(false);
    expect(creative.generationProvenance!.attachedSource).toEqual({ type: 'TRA_VIDEO_FRAMES', mediaId,
      sourceSha256: sourceHash, selectionMode: 'AUTOMATIC', frames: [{ timestampMs: 1200, approvedPngSha256: 'e'.repeat(64) }] });
    expect(creative.videoFrameSelection).toEqual(selection);
  });

  it('keeps explicit request video selection USER_SELECTED', async () => {
    expect((await render(true)).generationProvenance!.attachedSource).toMatchObject({ selectionMode: 'USER_SELECTED' });
  });
});
