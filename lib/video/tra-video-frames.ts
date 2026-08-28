import { createHash } from 'node:crypto';
import type { HydratedCreativeSourceAsset } from '@/lib/media/source-hydration';
import { detectImageMimeType } from '@/lib/media/storage';
import {
  getVideoFrameCache,
  getVideoFrameCacheKey,
  type VideoFrameCache,
} from '@/lib/video/frame-cache';
import {
  FfmpegTraVideoProcessor,
  type TraVideoProcessor,
} from '@/lib/video/ffmpeg';
import {
  MAX_REPRESENTATIVE_VIDEO_FRAMES,
  type ApprovedTraVideoFrame,
  type ApprovedTraVideoFrameSet,
  type VideoFrameManifest,
} from '@/lib/video/types';

type HydratedTraVideoSource = HydratedCreativeSourceAsset & {
  role: 'TRA_VIDEO';
};

const isHydratedTraVideoSource = (
  source: HydratedCreativeSourceAsset
): source is HydratedTraVideoSource =>
  source.role === 'TRA_VIDEO' &&
  source.media.mediaType === 'VIDEO' &&
  source.media.mimeType === 'video/mp4' &&
  source.stored.mediaType === 'VIDEO' &&
  source.stored.mimeType === 'video/mp4';

export const selectRepresentativeVideoTimestamps = (durationMs: number) => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];

  const fractions =
    durationMs < 1_500
      ? [0]
      : durationMs < 5_000
        ? [0, 0.5, 0.9]
        : [0, 0.2, 0.4, 0.6, 0.8, 0.95];
  const latestTimestamp = Math.max(0, Math.floor(durationMs - 50));

  return Array.from(
    new Set(
      fractions.map((fraction) =>
        Math.min(latestTimestamp, Math.max(0, Math.round(durationMs * fraction)))
      )
    )
  ).slice(0, MAX_REPRESENTATIVE_VIDEO_FRAMES);
};

const getContentHash = (buffer: Buffer) =>
  createHash('sha256').update(buffer).digest('hex');

const frameFromManifest = (
  source: HydratedTraVideoSource,
  sourceVideoContentHash: string,
  frame: VideoFrameManifest['frames'][number],
  buffer: Buffer
): ApprovedTraVideoFrame => ({
  frameIndex: frame.frameIndex,
  timestampMs: frame.timestampMs,
  mimeType: 'image/png',
  buffer,
  sourceRole: 'TRA_VIDEO',
  sourceVideoMediaId: source.media.id,
  sourceVideoFileName: source.media.fileName,
  sourceVideoContentHash,
  approvedHumanSource: true,
  cacheKey: frame.cacheKey,
});

const readCachedFrames = async (
  source: HydratedTraVideoSource,
  sourceVideoContentHash: string,
  cache: VideoFrameCache
): Promise<ApprovedTraVideoFrameSet | null> => {
  const manifest = await cache.readManifest(source.media.id, sourceVideoContentHash);
  if (!manifest || manifest.sourceVideoFileName !== source.media.fileName) return null;

  const frames: ApprovedTraVideoFrame[] = [];
  for (const frame of manifest.frames) {
    const buffer = await cache.readFrame(frame.cacheKey);
    if (!buffer || detectImageMimeType(buffer) !== 'image/png') return null;
    frames.push(frameFromManifest(source, sourceVideoContentHash, frame, buffer));
  }

  return {
    source,
    sourceVideoContentHash,
    durationMs: manifest.durationMs,
    frames,
    reused: true,
  };
};

export const getApprovedTraVideoFrames = async (
  source: HydratedCreativeSourceAsset,
  dependencies: {
    cache?: VideoFrameCache;
    processor?: TraVideoProcessor;
  } = {}
): Promise<ApprovedTraVideoFrameSet> => {
  if (!isHydratedTraVideoSource(source)) {
    throw new Error(
      'Only a server-hydrated TRA_VIDEO MP4 may enter approved TRA video-frame preprocessing.'
    );
  }

  const sourceVideoContentHash = getContentHash(source.stored.buffer);
  const cache = dependencies.cache || getVideoFrameCache();
  const cached = await readCachedFrames(source, sourceVideoContentHash, cache);
  if (cached) return cached;

  const processor = dependencies.processor || new FfmpegTraVideoProcessor();
  const processed = await processor.process(
    source.stored.buffer,
    source.stored.fileName,
    selectRepresentativeVideoTimestamps
  );
  const expectedTimestamps = selectRepresentativeVideoTimestamps(processed.durationMs);

  if (
    processed.frames.length < 1 ||
    processed.frames.length > MAX_REPRESENTATIVE_VIDEO_FRAMES ||
    processed.frames.length !== expectedTimestamps.length
  ) {
    throw new Error('TRA video preprocessing returned an invalid representative frame set.');
  }

  const manifestFrames: VideoFrameManifest['frames'] = [];
  const approvedFrames: ApprovedTraVideoFrame[] = [];

  for (let index = 0; index < processed.frames.length; index += 1) {
    const extracted = processed.frames[index];
    if (
      extracted.timestampMs !== expectedTimestamps[index] ||
      detectImageMimeType(extracted.buffer) !== 'image/png'
    ) {
      throw new Error('TRA video preprocessing returned an invalid representative frame.');
    }

    const cacheKey = getVideoFrameCacheKey(
      source.media.id,
      sourceVideoContentHash,
      index
    );
    await cache.writeFrame(cacheKey, extracted.buffer);
    const manifestFrame = {
      frameIndex: index,
      timestampMs: extracted.timestampMs,
      mimeType: 'image/png' as const,
      cacheKey,
    };
    manifestFrames.push(manifestFrame);
    approvedFrames.push(
      frameFromManifest(
        source,
        sourceVideoContentHash,
        manifestFrame,
        extracted.buffer
      )
    );
  }

  const manifest: VideoFrameManifest = {
    version: 1,
    sourceRole: 'TRA_VIDEO',
    sourceVideoMediaId: source.media.id,
    sourceVideoFileName: source.media.fileName,
    sourceVideoMimeType: 'video/mp4',
    sourceVideoContentHash,
    durationMs: processed.durationMs,
    frames: manifestFrames,
  };
  await cache.writeManifest(manifest);

  return {
    source,
    sourceVideoContentHash,
    durationMs: processed.durationMs,
    frames: approvedFrames,
    reused: false,
  };
};
