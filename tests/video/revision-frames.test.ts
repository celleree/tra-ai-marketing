import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import type { HydratedCreativeSourceAsset } from '@/lib/media/source-hydration';
import type { GeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import { resolveRevisionVideoFrames } from '@/lib/video/revision-frames';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';

const mocks = vi.hoisted(() => ({ automatic: vi.fn(), loadLibrary: vi.fn(), selected: vi.fn() }));
vi.mock('@/lib/video/tra-video-frames', () => ({ getApprovedTraVideoFrames: mocks.automatic }));
vi.mock('@/lib/video/selection-context', () => ({ loadVideoSelectionContext: mocks.loadLibrary, extractVideoSelectionFrames: mocks.selected }));

const MEDIA_ID = `media_${'a'.repeat(32)}`;
const VIDEO = Buffer.from('stored TRA video bytes');
const digest = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const SOURCE_HASH = digest(VIDEO);
const png = (value: string) => Buffer.from(`png:${value}`);
const source = (): HydratedCreativeSourceAsset => ({
  role: 'TRA_VIDEO',
  media: { id: MEDIA_ID, fileName: `${MEDIA_ID}.mp4`, mimeType: 'video/mp4', mediaType: 'VIDEO', size: VIDEO.length, url: `/api/media/files/${MEDIA_ID}.mp4` },
  stored: { fileName: `${MEDIA_ID}.mp4`, buffer: VIDEO, mimeType: 'video/mp4', mediaType: 'VIDEO' },
});
const frame = (timestampMs: number, buffer: Buffer, frameIndex = 0): ApprovedTraVideoFrame => ({
  frameIndex, timestampMs, mimeType: 'image/png', buffer, frameSha256: digest(buffer), byteLength: buffer.length,
  sourceRole: 'TRA_VIDEO', sourceVideoMediaId: MEDIA_ID, sourceVideoFileName: `${MEDIA_ID}.mp4`,
  sourceVideoContentHash: SOURCE_HASH, approvedHumanSource: true, cacheKey: null,
});
type SavedSource = Extract<CreativeGenerationProvenance['attachedSource'], { type: 'TRA_VIDEO_FRAMES' }>;
const attached = (selectionMode: SavedSource['selectionMode'], frames: ApprovedTraVideoFrame[], legacy = false): SavedSource => ({
  type: 'TRA_VIDEO_FRAMES', mediaId: MEDIA_ID, sourceSha256: SOURCE_HASH, selectionMode,
  frames: frames.map(({ timestampMs, frameSha256 }) => ({ timestampMs, approvedPngSha256: frameSha256,
    ...(legacy ? {} : { providerPngSha256: frameSha256, sourceOverlay: { version: 2 as const, status: 'CLEAN' as const }, crop: null }) })),
});
const FRAME_IDS = [`video-frame:${'1'.repeat(64)}`, `video-frame:${'2'.repeat(64)}`];
const LIBRARY_ID = `video-library:${'3'.repeat(64)}`;
const selection = (frames: ApprovedTraVideoFrame[]): GeneratedVideoFrameSelection => ({
  libraryId: LIBRARY_ID, sourceVideoMediaId: MEDIA_ID, sourceVideoContentHash: SOURCE_HASH,
  frames: frames.map((item, index) => ({
    frameIndex: index, libraryFrameId: FRAME_IDS[index], candidateFrameSha256: String(index + 4).repeat(64),
    timestampMs: item.timestampMs, approvedPngSha256: item.frameSha256,
  })),
});
const automaticSet = (frames: ApprovedTraVideoFrame[]) => ({
  source: source(), sourceVideoContentHash: SOURCE_HASH, durationMs: 5_000, frames, reused: true,
});

beforeEach(() => {
  mocks.automatic.mockReset();
  mocks.loadLibrary.mockReset();
  mocks.selected.mockReset();
});

describe('revision TRA video frames', () => {
  it('keeps an old unassessed creative readable but blocks source reuse on revision', async () => {
    const saved = frame(0, png('saved'));
    mocks.automatic.mockResolvedValue(automaticSet([saved]));
    await expect(resolveRevisionVideoFrames(source(), attached('AUTOMATIC', [saved], true)))
      .rejects.toThrow('predates source-overlay assessment');
  });
  it('reconstructs the exact saved automatic subset in saved order', async () => {
    const first = frame(0, png('first'), 0);
    const middle = frame(2_000, png('middle'), 1);
    const last = frame(4_000, png('last'), 2);
    mocks.automatic.mockResolvedValue(automaticSet([first, middle, last]));
    await expect(resolveRevisionVideoFrames(source(), attached('AUTOMATIC', [last, first])))
      .resolves.toMatchObject([last, first]);
    expect(mocks.loadLibrary).not.toHaveBeenCalled();
  });

  it.each([
    ['typed role', { ...source(), role: 'LAYOUT_REFERENCE' }],
    ['media ID', { ...source(), media: { ...source().media, id: `media_${'b'.repeat(32)}` } }],
    ['source bytes', { ...source(), stored: { ...source().stored, buffer: Buffer.from('changed') } }],
  ])('rejects a mismatched %s before processing', async (_name, input) => {
    await expect(resolveRevisionVideoFrames(input as HydratedCreativeSourceAsset, attached('AUTOMATIC', [frame(0, png('saved'))])))
      .rejects.toThrow(/TRA_VIDEO|changed/);
    expect(mocks.automatic).not.toHaveBeenCalled();
  });

  it.each([
    ['different approved pixels', (saved: ApprovedTraVideoFrame) => frame(0, png('changed')), 'no longer matches approved PNG pixels'],
    ['substituted bytes behind saved metadata', (saved: ApprovedTraVideoFrame) => ({ ...saved, buffer: png('changed') }), 'integrity validation'],
  ])('rejects %s', async (_name, replacement, message) => {
    const saved = frame(0, png('saved'));
    mocks.automatic.mockResolvedValue(automaticSet([replacement(saved)]));
    await expect(resolveRevisionVideoFrames(source(), attached('AUTOMATIC', [saved])))
      .rejects.toThrow(message);
  });

  it('does not use generic automatic frames when selection metadata is present', async () => {
    const saved = frame(0, png('saved'));
    await expect(resolveRevisionVideoFrames(source(), attached('AUTOMATIC', [saved]), selection([saved])))
      .rejects.toThrow('library is missing or invalid');
    expect(mocks.automatic).not.toHaveBeenCalled();
  });

  it('reconstructs selected frames through the exact saved library and provenance', async () => {
    const frames = [frame(1_000, png('first'), 0), frame(3_000, png('second'), 1)];
    const savedSelection = selection(frames);
    const library = { id: LIBRARY_ID };
    mocks.loadLibrary.mockResolvedValue({ library, manifest: null });
    mocks.selected.mockResolvedValue({ ...automaticSet(frames), reused: false, selectionProvenance: savedSelection.frames });
    await expect(resolveRevisionVideoFrames(source(), attached('USER_SELECTED', frames), savedSelection))
      .resolves.toMatchObject(frames);
    expect(mocks.loadLibrary).toHaveBeenCalledWith(expect.objectContaining({ role: 'TRA_VIDEO', media: expect.objectContaining({ id: MEDIA_ID }) }));
    expect(mocks.selected).toHaveBeenCalledWith(expect.objectContaining({ role: 'TRA_VIDEO' }), { library, manifest: null }, FRAME_IDS);
  });

  it.each([
    ['selection mismatch', async (_saved: ApprovedTraVideoFrame, savedSelection: GeneratedVideoFrameSelection) => {
      savedSelection.frames[0].timestampMs += 1;
    }, 'does not match this creative provenance'],
    ['library mismatch', async () => {
      mocks.loadLibrary.mockResolvedValue({ library: { id: `video-library:${'9'.repeat(64)}` }, manifest: null });
    }, 'library is missing or invalid'],
    ['fresh provenance drift', async (saved: ApprovedTraVideoFrame, savedSelection: GeneratedVideoFrameSelection) => {
      mocks.loadLibrary.mockResolvedValue({ library: { id: LIBRARY_ID }, manifest: null });
      mocks.selected.mockResolvedValue({ ...automaticSet([saved]), reused: false,
        selectionProvenance: [{ ...savedSelection.frames[0], candidateFrameSha256: 'f'.repeat(64) }] });
    }, 'no longer match saved provenance'],
  ])('rejects selected-frame %s', async (_name, arrange, message) => {
    const saved = frame(1_000, png('saved'));
    const savedSelection = selection([saved]);
    await arrange(saved, savedSelection);
    await expect(resolveRevisionVideoFrames(source(), attached('USER_SELECTED', [saved]), savedSelection))
      .rejects.toThrow(message);
  });

  it('propagates the selected-video production guard without fallback', async () => {
    const saved = frame(1_000, png('saved'));
    mocks.loadLibrary.mockRejectedValue(new Error('Video intelligence is currently available in local development only.'));
    await expect(resolveRevisionVideoFrames(source(), attached('USER_SELECTED', [saved]), selection([saved])))
      .rejects.toThrow('local development only');
    expect(mocks.selected).not.toHaveBeenCalled();
    expect(mocks.automatic).not.toHaveBeenCalled();
  });
});
