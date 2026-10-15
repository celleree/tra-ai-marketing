import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ storage: vi.fn(), hydrate: vi.fn(), context: vi.fn(), extract: vi.fn() }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: mocks.storage }));
vi.mock('@/lib/media/source-hydration', () => ({ hydrateCreativeSourceSelections: mocks.hydrate,
  findEligibleProviderImageSource: () => undefined }));
vi.mock('@/lib/video/selection-context', () => ({ loadVideoSelectionContext: mocks.context,
  extractVideoSelectionFrames: mocks.extract }));
vi.mock('@/lib/video/preview-availability', () => ({ isDurableVideoIntelligenceAvailable: () => true }));

import { hydrateGenerationSources } from '@/lib/creatives/generation-sources';
import { videoCandidateFrameId } from '@/lib/video/generation-selection-contract';
import { prepareProviderVideoFrames } from '@/lib/video/source-overlay';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const video = Buffer.from('hydrated original video');
const sourceHash = hash(video);
const mediaId = `media_${'a'.repeat(32)}`;
const libraryId = `video-library:${'b'.repeat(64)}`;
const librarySha256 = 'c'.repeat(64);
const candidateSha = 'd'.repeat(64);
const representativeFrameId = `video-frame:${'e'.repeat(64)}`;
const candidateIndex = 7;
const timestampMs = 1200;
const frameId = videoCandidateFrameId(sourceHash, timestampMs, candidateSha);
const overlay = { version: 2 as const, status: 'EDGE_CROP' as const, edge: 'BOTTOM' as const,
  removePermille: 100, overlayDepthPermille: 80 };
const selection = () => ({ version: 3 as const, libraryId, sourceVideoMediaId: mediaId,
  sourceVideoContentHash: sourceHash, librarySha256, frameIds: [frameId],
  candidateBindings: [{ frameId, representativeFrameId, candidateIndex, timestampMs, frameSha256: candidateSha }],
  sourceOverlays: [overlay] });

beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('OPENAI_API_KEY', 'offline-fixture');
  mocks.storage.mockReturnValue({});
  mocks.hydrate.mockResolvedValue([{ role: 'TRA_VIDEO', media: { id: mediaId, mediaType: 'VIDEO', mimeType: 'video/mp4',
    fileName: 'source.mp4', size: video.length }, stored: { buffer: video, mediaType: 'VIDEO', mimeType: 'video/mp4', fileName: 'source.mp4' } }]);
  mocks.context.mockResolvedValue({ library: { id: libraryId }, librarySha256, manifest: {} });
});

describe('candidate-addressable generation hydration', () => {
  it('carries the actual candidate and applies the assessed crop to provider pixels', async () => {
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#345678' } }).png().toBuffer();
    mocks.extract.mockImplementation(async source => ({ source, sourceVideoContentHash: sourceHash,
      frames: [{ frameIndex: 0, timestampMs, mimeType: 'image/png', buffer: png, frameSha256: hash(png),
        byteLength: png.length, sourceRole: 'TRA_VIDEO', sourceVideoMediaId: mediaId, sourceVideoFileName: 'source.mp4',
        sourceVideoContentHash: sourceHash, approvedHumanSource: true, cacheKey: null }],
      selectionProvenance: [{ frameIndex: 0, libraryFrameId: frameId, representativeFrameId,
        candidateIndex, candidateFrameSha256: candidateSha, timestampMs, approvedPngSha256: hash(png) }] }));
    const hydrated = await hydrateGenerationSources({ sourceAssets: [{ role: 'TRA_VIDEO', mediaId }],
      videoFrameSelection: selection() } as any);
    expect(mocks.extract).toHaveBeenCalledWith(expect.anything(), expect.anything(), selection().candidateBindings);
    expect(hydrated.generatedVideoFrameSelection).toMatchObject({ libraryId, librarySha256,
      frames: [{ libraryFrameId: frameId, representativeFrameId, candidateIndex,
        candidateFrameSha256: candidateSha, approvedPngSha256: hash(png) }] });
    const [provider] = await prepareProviderVideoFrames(hydrated.videoFrameSet!.frames);
    expect(provider.sourceOverlay).toEqual(overlay);
    expect(provider.crop).toEqual({ left: 0, top: 0, width: 100, height: 90 });
    expect(provider.providerPngSha256).toBe(hash(provider.providerBuffer));
    expect(provider.providerPngSha256).not.toBe(hash(png));
  });

  it('rejects stale library identity and substituted extraction provenance before provider pixels', async () => {
    mocks.context.mockResolvedValueOnce({ library: { id: libraryId }, librarySha256: 'f'.repeat(64), manifest: {} });
    await expect(hydrateGenerationSources({ sourceAssets: [{ role: 'TRA_VIDEO', mediaId }],
      videoFrameSelection: selection() } as any)).rejects.toThrow('candidate is stale');
    expect(mocks.extract).not.toHaveBeenCalled();
    mocks.extract.mockResolvedValue({ frames: [{ frameIndex: 0, timestampMs, frameSha256: 'f'.repeat(64) }],
      selectionProvenance: [{ frameIndex: 0, libraryFrameId: representativeFrameId,
        candidateIndex, timestampMs, approvedPngSha256: 'f'.repeat(64) }] });
    await expect(hydrateGenerationSources({ sourceAssets: [{ role: 'TRA_VIDEO', mediaId }],
      videoFrameSelection: selection() } as any)).rejects.toThrow('provenance changed');
  });
});
