import { describe, expect, it, vi } from 'vitest';
import type { HydratedCreativeSourceAsset } from '@/lib/media/source-hydration';
import { getVideoFrameIntegrity, type VideoFrameCache } from '@/lib/video/frame-cache';
import type { TraVideoProcessor } from '@/lib/video/ffmpeg';
import {
  getApprovedTraVideoFrames,
  selectRepresentativeVideoTimestamps,
} from '@/lib/video/tra-video-frames';
import type { VideoFrameManifest } from '@/lib/video/types';
import { REAL_ENCODED_MP4 } from '@/tests/fixtures/media';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const SUBSTITUTE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==', 'base64');
const MEDIA_ID = `media_${'a'.repeat(32)}`;

const makeVideoSource = (buffer = REAL_ENCODED_MP4): HydratedCreativeSourceAsset => ({
  role: 'TRA_VIDEO',
  media: { id: MEDIA_ID, fileName: `${MEDIA_ID}.mp4`, mimeType: 'video/mp4', mediaType: 'VIDEO', size: buffer.length, url: `/api/media/files/${MEDIA_ID}.mp4` },
  stored: { fileName: `${MEDIA_ID}.mp4`, buffer, mimeType: 'video/mp4', mediaType: 'VIDEO' },
});

class MemoryVideoFrameCache implements VideoFrameCache {
  manifest: VideoFrameManifest | null = null;
  frames = new Map<string, Buffer>();
  async readManifest(mediaId: string, contentHash: string) {
    return this.manifest?.sourceVideoMediaId === mediaId && this.manifest.sourceVideoContentHash === contentHash ? this.manifest : null;
  }
  async readFrame(cacheKey: string) { return this.frames.get(cacheKey) || null; }
  async writeFrame(cacheKey: string, buffer: Buffer) { this.frames.set(cacheKey, buffer); }
  async writeManifest(manifest: VideoFrameManifest) { this.manifest = manifest; }
}

const makeProcessor = (png = PNG) => {
  const process = vi.fn<TraVideoProcessor['process']>(async (_video, _fileName, selectTimestamps) => {
    const durationMs = 10_000;
    return { durationMs, frames: selectTimestamps(durationMs).map((timestampMs) => ({ timestampMs, buffer: png })) };
  });
  return { process } satisfies TraVideoProcessor;
};

const seedCache = async (cache: MemoryVideoFrameCache) =>
  getApprovedTraVideoFrames(makeVideoSource(), { cache, processor: makeProcessor() });

describe('TRA video representative frame preprocessing', () => {
  it('selects a bounded representative timestamp set', () => {
    expect(selectRepresentativeVideoTimestamps(1_000)).toEqual([0]);
    expect(selectRepresentativeVideoTimestamps(4_000)).toEqual([0, 2_000, 3_600]);
    expect(selectRepresentativeVideoTimestamps(10_000)).toEqual([0, 2_000, 4_000, 6_000, 8_000, 9_500]);
  });

  it('retains source-video and per-frame integrity provenance on every approved frame', async () => {
    const cache = new MemoryVideoFrameCache();
    const result = await seedCache(cache);
    expect(result.reused).toBe(false);
    expect(result.frames).toHaveLength(6);
    expect(cache.frames.size).toBe(6);
    expect(cache.manifest?.version).toBe(2);
    expect(cache.manifest?.frames).toHaveLength(6);
    const integrity = getVideoFrameIntegrity(PNG);
    expect(result.frames.every((frame) =>
      frame.sourceRole === 'TRA_VIDEO' &&
      frame.sourceVideoMediaId === MEDIA_ID &&
      frame.approvedHumanSource &&
      frame.sourceVideoContentHash === result.sourceVideoContentHash &&
      frame.frameSha256 === integrity.frameSha256 &&
      frame.byteLength === integrity.byteLength
    )).toBe(true);
  });

  it('reuses cached frames for unchanged video bytes without reprocessing', async () => {
    const cache = new MemoryVideoFrameCache();
    await seedCache(cache);
    const processor = { process: vi.fn<TraVideoProcessor['process']>(async () => { throw new Error('must not run'); }) } satisfies TraVideoProcessor;
    const reused = await getApprovedTraVideoFrames(makeVideoSource(), { cache, processor });
    expect(reused.reused).toBe(true);
    expect(processor.process).not.toHaveBeenCalled();
  });

  it('uses content hash in cache identity so changed bytes are reprocessed', async () => {
    const cache = new MemoryVideoFrameCache();
    const processor = makeProcessor();
    const first = await getApprovedTraVideoFrames(makeVideoSource(), { cache, processor });
    const second = await getApprovedTraVideoFrames(makeVideoSource(Buffer.concat([REAL_ENCODED_MP4, Buffer.from([1])])), { cache, processor });
    expect(first.sourceVideoContentHash).not.toBe(second.sourceVideoContentHash);
    expect(processor.process).toHaveBeenCalledTimes(2);
  });

  it('rejects substituted structurally valid PNG bytes and regenerates instead of inheriting approved-human provenance', async () => {
    const cache = new MemoryVideoFrameCache();
    await seedCache(cache);
    const firstKey = cache.manifest!.frames[0].cacheKey;
    cache.frames.set(firstKey, SUBSTITUTE_PNG);
    const processor = makeProcessor();

    const result = await getApprovedTraVideoFrames(makeVideoSource(), { cache, processor });

    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(result.reused).toBe(false);
    expect(result.frames[0].buffer.equals(SUBSTITUTE_PNG)).toBe(false);
    expect(result.frames[0].approvedHumanSource).toBe(true);
    expect(result.frames[0].frameSha256).toBe(getVideoFrameIntegrity(PNG).frameSha256);
  });

  it('rejects a cached frame when the recorded SHA-256 does not match actual bytes', async () => {
    const cache = new MemoryVideoFrameCache();
    await seedCache(cache);
    cache.manifest!.frames[0].frameSha256 = 'f'.repeat(64);
    const processor = makeProcessor();
    const result = await getApprovedTraVideoFrames(makeVideoSource(), { cache, processor });
    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(result.reused).toBe(false);
  });

  it('rejects a cached frame when the recorded byte length does not match actual bytes', async () => {
    const cache = new MemoryVideoFrameCache();
    await seedCache(cache);
    cache.manifest!.frames[0].byteLength += 1;
    const processor = makeProcessor();
    const result = await getApprovedTraVideoFrames(makeVideoSource(), { cache, processor });
    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(result.reused).toBe(false);
  });

  it('rejects a stale cached representative timestamp set and regenerates the deterministic set', async () => {
    const cache = new MemoryVideoFrameCache();
    await seedCache(cache);
    cache.manifest!.frames[1].timestampMs = 2_001;
    const processor = makeProcessor();
    const result = await getApprovedTraVideoFrames(makeVideoSource(), { cache, processor });
    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(result.reused).toBe(false);
    expect(result.frames.map((frame) => frame.timestampMs)).toEqual([0, 2_000, 4_000, 6_000, 8_000, 9_500]);
  });

  it('returns no approved cached frame when integrity fails and regeneration fails', async () => {
    const cache = new MemoryVideoFrameCache();
    await seedCache(cache);
    const firstKey = cache.manifest!.frames[0].cacheKey;
    cache.frames.set(firstKey, SUBSTITUTE_PNG);
    const processor = { process: vi.fn<TraVideoProcessor['process']>(async () => { throw new Error('regeneration failed'); }) } satisfies TraVideoProcessor;

    await expect(getApprovedTraVideoFrames(makeVideoSource(), { cache, processor })).rejects.toThrow('regeneration failed');
    expect(processor.process).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-TRA-video role before processing', async () => {
    const source = { ...makeVideoSource(), role: 'LAYOUT_REFERENCE' } as HydratedCreativeSourceAsset;
    const processor = makeProcessor();
    await expect(getApprovedTraVideoFrames(source, { cache: new MemoryVideoFrameCache(), processor })).rejects.toThrow('Only a server-hydrated TRA_VIDEO MP4');
    expect(processor.process).not.toHaveBeenCalled();
  });
});
