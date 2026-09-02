import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HydratedCreativeSourceAsset } from '@/lib/media/source-hydration';
import type {
  CanonicalCreativeSourceMediaAsset,
  StoredCreativeSourceMediaFile,
} from '@/lib/media/types';
import { detectImageMimeType } from '@/lib/media/storage';
import {
  DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
  getEffectiveIntervalFps,
  validateVideoFrameCandidatePolicy,
} from '@/lib/video/candidate-policy';
import type {
  TemporaryVideoFrameCandidate,
  TemporaryVideoFrameCandidateMaterialization,
  TemporaryVideoFrameCandidateSet,
  VideoFrameCandidatePolicy,
} from '@/lib/video/candidate-types';
import {
  runFfmpeg,
  TraVideoProcessingError,
} from '@/lib/video/ffmpeg';

export type HydratedTraVideoSource = HydratedCreativeSourceAsset & {
  role: 'TRA_VIDEO';
  media: Extract<CanonicalCreativeSourceMediaAsset, { mediaType: 'VIDEO' }>;
  stored: Extract<StoredCreativeSourceMediaFile, { mediaType: 'VIDEO' }>;
};

export interface TraVideoCandidateExtractor {
  extractCandidates(
    source: HydratedTraVideoSource,
    policy?: VideoFrameCandidatePolicy
  ): Promise<TemporaryVideoFrameCandidateSet>;
}

export interface TraVideoSceneCandidateMaterializer {
  materializeCandidates(
    source: HydratedTraVideoSource,
    sceneTimestampsMs: readonly number[],
    policy?: VideoFrameCandidatePolicy
  ): Promise<TemporaryVideoFrameCandidateMaterialization>;
}

type FfmpegRunner = typeof runFfmpeg;

interface FfmpegIntervalCandidateExtractorDependencies {
  run?: FfmpegRunner;
  temporaryRoot?: string;
}

const CANDIDATE_FILE_PATTERN = /^candidate-(\d{6})\.jpg$/;

const toSha256 = (buffer: Buffer) =>
  createHash('sha256').update(buffer).digest('hex');

const toFfmpegJpegQuality = (quality: number) =>
  Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)));

const validateTraVideoSource = (source: HydratedTraVideoSource) => {
  if (
    source.role !== 'TRA_VIDEO' ||
    source.media.mediaType !== 'VIDEO' ||
    source.media.mimeType !== 'video/mp4' ||
    source.stored.mediaType !== 'VIDEO' ||
    source.stored.mimeType !== 'video/mp4'
  ) {
    throw new Error(
      'Only a server-hydrated TRA_VIDEO MP4 may enter interval candidate extraction.'
    );
  }
};

const getJpegDimensions = (buffer: Buffer) => {
  if (
    detectImageMimeType(buffer) !== 'image/jpeg' ||
    buffer.length < 4 ||
    buffer[buffer.length - 2] !== 0xff ||
    buffer[buffer.length - 1] !== 0xd9
  ) {
    return null;
  }

  let offset = 2;
  let dimensions: { width: number; height: number } | null = null;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
    if (marker === 0xda) {
      const componentCount = buffer[offset + 2];
      if (
        !dimensions ||
        segmentLength !== 6 + componentCount * 2
      ) {
        return null;
      }
      offset += segmentLength;
      let entropyByteCount = 0;
      while (offset < buffer.length - 2) {
        if (buffer[offset] !== 0xff) {
          entropyByteCount += 1;
          offset += 1;
          continue;
        }
        const next = buffer[offset + 1];
        if (next === 0x00) {
          entropyByteCount += 1;
          offset += 2;
          continue;
        }
        if (next >= 0xd0 && next <= 0xd7) {
          offset += 2;
          continue;
        }
        return null;
      }
      return entropyByteCount > 0 ? dimensions : null;
    }
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (segmentLength < 7) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width < 1 || height < 1) return null;
      dimensions = { width, height };
    }
    offset += segmentLength;
  }
  return null;
};

const materializeTemporaryCandidate = async ({
  source,
  sourceVideoContentHash,
  policy,
  candidateIndex,
  timestampMs,
  temporaryPath,
  extractionReasons,
  operation,
}: {
  source: HydratedTraVideoSource;
  sourceVideoContentHash: string;
  policy: VideoFrameCandidatePolicy;
  candidateIndex: number;
  timestampMs: number;
  temporaryPath: string;
  extractionReasons: TemporaryVideoFrameCandidate['extractionReasons'];
  operation: string;
}): Promise<TemporaryVideoFrameCandidate> => {
  const buffer = await readFile(temporaryPath);
  const dimensions = getJpegDimensions(buffer);
  if (!dimensions || dimensions.width > policy.maxWidth) {
    throw new TraVideoProcessingError(
      `FFmpeg produced an invalid JPEG ${operation} candidate at index ${candidateIndex}.`,
      400,
      'FRAME_EXTRACTION_FAILED'
    );
  }
  return {
    candidateIndex,
    timestampMs,
    sourceRole: 'TRA_VIDEO',
    sourceVideoMediaId: source.media.id,
    sourceVideoFileName: source.media.fileName,
    sourceVideoContentHash,
    mimeType: 'image/jpeg',
    width: dimensions.width,
    height: dimensions.height,
    byteLength: buffer.length,
    frameSha256: toSha256(buffer),
    extractionReasons,
    temporaryPath,
    lifecycle: 'TEMPORARY',
    providerEligible: false,
  };
};

const parseIntervalTimestamps = (stderr: string) => {
  const timestamps: Array<{ outputIndex: number; timestampMs: number }> = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes('Parsed_showinfo')) continue;
    const match = line.match(/\bn:\s*(\d+).*?\bpts_time:\s*(-?\d+(?:\.\d+)?)/);
    if (!match) continue;
    const outputIndex = Number(match[1]);
    const timestampMs = Math.round(Number(match[2]) * 1000);
    if (!Number.isSafeInteger(outputIndex) || !Number.isFinite(timestampMs)) {
      throw new TraVideoProcessingError(
        'FFmpeg returned malformed interval candidate timestamps.',
        400,
        'FRAME_EXTRACTION_FAILED'
      );
    }
    timestamps.push({ outputIndex, timestampMs });
  }
  return timestamps;
};

const buildSceneSelectionFilter = (sceneTimestampsMs: readonly number[]) =>
  `select='${sceneTimestampsMs
    .map(
      (timestampMs, index) =>
        `eq(selected_n,${index})*gte(t,${(timestampMs - 0.5) / 1000})`
    )
    .join('+')}'`;

const requireValidProbe = (stdout: Buffer) => {
  const progress = stdout.toString('utf8');
  const matches = [...progress.matchAll(/^out_time_us=(\d+)$/gm)];
  const outTimeUs = Number(matches.at(-1)?.[1]);
  const durationMs = Math.round(outTimeUs / 1000);
  if (
    !progress.includes('progress=end') ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    throw new TraVideoProcessingError(
      'The TRA video does not contain a decodable video stream with a usable duration.'
    );
  }
  return durationMs;
};

export class FfmpegIntervalCandidateExtractor
  implements TraVideoCandidateExtractor
{
  private readonly run: FfmpegRunner;
  private readonly temporaryRoot: string;

  constructor(
    dependencies: FfmpegIntervalCandidateExtractorDependencies = {}
  ) {
    this.run = dependencies.run || runFfmpeg;
    this.temporaryRoot = dependencies.temporaryRoot || tmpdir();
  }

  async extractCandidates(
    source: HydratedTraVideoSource,
    policy: VideoFrameCandidatePolicy = DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY
  ): Promise<TemporaryVideoFrameCandidateSet> {
    validateTraVideoSource(source);

    const resolvedPolicy = { ...policy };
    validateVideoFrameCandidatePolicy(resolvedPolicy);

    const temporaryDirectory = await mkdtemp(
      path.join(this.temporaryRoot, 'tra-video-candidates-')
    );
    const inputPath = path.join(temporaryDirectory, 'source.mp4');
    const outputPattern = path.join(
      temporaryDirectory,
      'candidate-%06d.jpg'
    );
    let completed = false;

    try {
      await writeFile(inputPath, source.stored.buffer);

      let probe;
      try {
        probe = await this.run([
          '-hide_banner',
          '-nostdin',
          '-v',
          'error',
          '-i',
          inputPath,
          '-map',
          '0:v:0',
          '-c:v',
          'copy',
          '-f',
          'null',
          '-',
          '-progress',
          'pipe:1',
          '-nostats',
        ]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            'FFmpeg runtime is unavailable for TRA video candidate extraction.'
          );
        }
        throw new TraVideoProcessingError(
          'The TRA video could not be decoded. Upload a supported, non-corrupt MP4 video.'
        );
      }

      const durationMs = requireValidProbe(probe.stdout);
      const effectiveIntervalFps = getEffectiveIntervalFps(
        durationMs,
        resolvedPolicy
      );
      const intervalLimit = Math.min(
        resolvedPolicy.maxIntervalCandidates,
        resolvedPolicy.maxTotalCandidates
      );

      let extracted;
      try {
        extracted = await this.run([
          '-hide_banner',
          '-nostdin',
          '-v',
          'info',
          '-i',
          inputPath,
          '-map',
          '0:v:0',
          '-vf',
          `fps=${effectiveIntervalFps}:eof_action=pass,scale=w='min(iw,${resolvedPolicy.maxWidth})':h=-2,showinfo`,
          '-frames:v',
          String(intervalLimit),
          '-fps_mode',
          'passthrough',
          '-q:v',
          String(toFfmpegJpegQuality(resolvedPolicy.jpegQuality)),
          '-start_number',
          '0',
          outputPattern,
        ]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            'FFmpeg runtime is unavailable for TRA video candidate extraction.'
          );
        }
        throw new TraVideoProcessingError(
          'The TRA video failed while extracting interval candidates.',
          400,
          'FRAME_EXTRACTION_FAILED'
        );
      }

      const candidateFiles = (await readdir(temporaryDirectory))
        .filter((fileName) => CANDIDATE_FILE_PATTERN.test(fileName))
        .sort();
      const timestamps = parseIntervalTimestamps(extracted.stderr);

      if (!candidateFiles.length) {
        throw new TraVideoProcessingError(
          'The TRA video produced no interval candidates.',
          400,
          'FRAME_EXTRACTION_FAILED'
        );
      }
      if (
        candidateFiles.length > intervalLimit ||
        candidateFiles.length > resolvedPolicy.maxIntervalCandidates ||
        candidateFiles.length > resolvedPolicy.maxTotalCandidates
      ) {
        throw new TraVideoProcessingError(
          'FFmpeg exceeded the bounded interval candidate limit.',
          400,
          'FRAME_EXTRACTION_FAILED'
        );
      }
      if (
        timestamps.length !== candidateFiles.length ||
        timestamps.some(
          (timestamp, index) =>
            timestamp.outputIndex !== index ||
            timestamp.timestampMs < 0 ||
            timestamp.timestampMs >= durationMs ||
            (index > 0 &&
              timestamp.timestampMs <= timestamps[index - 1].timestampMs)
        ) ||
        candidateFiles.some(
          (fileName, index) =>
            Number(fileName.match(CANDIDATE_FILE_PATTERN)?.[1]) !== index
        )
      ) {
        throw new TraVideoProcessingError(
          'FFmpeg interval candidate files did not match trustworthy timestamp metadata.',
          400,
          'FRAME_EXTRACTION_FAILED'
        );
      }

      const sourceVideoContentHash = toSha256(source.stored.buffer);
      const candidates: TemporaryVideoFrameCandidate[] = [];
      for (let candidateIndex = 0; candidateIndex < candidateFiles.length; candidateIndex += 1) {
        const temporaryPath = path.join(
          temporaryDirectory,
          candidateFiles[candidateIndex]
        );
        candidates.push(await materializeTemporaryCandidate({
          source,
          sourceVideoContentHash,
          policy: resolvedPolicy,
          candidateIndex,
          timestampMs: timestamps[candidateIndex].timestampMs,
          temporaryPath,
          extractionReasons: ['INTERVAL'],
          operation: 'interval',
        }));
      }

      completed = true;
      return {
        sourceVideoMediaId: source.media.id,
        sourceVideoFileName: source.media.fileName,
        sourceVideoContentHash,
        durationMs,
        policy: resolvedPolicy,
        effectiveIntervalFps,
        candidates,
        temporarySourceVideoPath: inputPath,
        temporaryDirectories: [temporaryDirectory],
      };
    } finally {
      if (!completed) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }
}

export class FfmpegSceneCandidateMaterializer
  implements TraVideoSceneCandidateMaterializer
{
  private readonly run: FfmpegRunner;
  private readonly temporaryRoot: string;

  constructor(dependencies: FfmpegIntervalCandidateExtractorDependencies = {}) {
    this.run = dependencies.run || runFfmpeg;
    this.temporaryRoot = dependencies.temporaryRoot || tmpdir();
  }

  async materializeCandidates(
    source: HydratedTraVideoSource,
    sceneTimestampsMs: readonly number[],
    policy: VideoFrameCandidatePolicy = DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY
  ): Promise<TemporaryVideoFrameCandidateMaterialization> {
    validateTraVideoSource(source);
    const resolvedPolicy = { ...policy };
    validateVideoFrameCandidatePolicy(resolvedPolicy);
    if (
      sceneTimestampsMs.length > resolvedPolicy.maxTotalCandidates ||
      sceneTimestampsMs.some(
        (timestampMs, index) =>
          !Number.isSafeInteger(timestampMs) ||
          timestampMs < 0 ||
          (index > 0 && timestampMs <= sceneTimestampsMs[index - 1])
      )
    ) {
      throw new Error('Scene timestamps must be bounded, non-negative, and strictly ordered.');
    }
    if (!sceneTimestampsMs.length) {
      return { candidates: [], temporaryDirectory: null };
    }

    const temporaryDirectory = await mkdtemp(
      path.join(this.temporaryRoot, 'tra-video-scene-candidates-')
    );
    const inputPath = path.join(temporaryDirectory, 'source.mp4');
    const outputPattern = path.join(
      temporaryDirectory,
      'candidate-%06d.jpg'
    );
    const expectedFiles = sceneTimestampsMs.map(
      (_, index) => `candidate-${String(index).padStart(6, '0')}.jpg`
    );
    let completed = false;

    try {
      await writeFile(inputPath, source.stored.buffer);
      let extracted;
      try {
        extracted = await this.run([
          '-hide_banner',
          '-nostdin',
          '-v',
          'info',
          '-i',
          inputPath,
          '-map',
          '0:v:0',
          '-vf',
          `${buildSceneSelectionFilter(sceneTimestampsMs)},scale=w='min(iw,${resolvedPolicy.maxWidth})':h=-2,showinfo`,
          '-frames:v',
          String(sceneTimestampsMs.length),
          '-fps_mode',
          'passthrough',
          '-an',
          '-q:v',
          String(toFfmpegJpegQuality(resolvedPolicy.jpegQuality)),
          '-start_number',
          '0',
          outputPattern,
        ]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('FFmpeg runtime is unavailable for TRA video candidate extraction.');
        }
        throw new TraVideoProcessingError(
          'The TRA video failed while extracting scene candidates.',
          400,
          'FRAME_EXTRACTION_FAILED'
        );
      }

      const candidateFiles = (await readdir(temporaryDirectory))
        .filter((fileName) => CANDIDATE_FILE_PATTERN.test(fileName))
        .sort();
      const extractedTimestamps = parseIntervalTimestamps(extracted.stderr);
      if (
        candidateFiles.length !== expectedFiles.length ||
        candidateFiles.some((fileName, index) => fileName !== expectedFiles[index]) ||
        extractedTimestamps.length !== sceneTimestampsMs.length ||
        extractedTimestamps.some(
          (timestamp, index) =>
            timestamp.outputIndex !== index ||
            timestamp.timestampMs !== sceneTimestampsMs[index] ||
            (index > 0 &&
              timestamp.timestampMs < extractedTimestamps[index - 1].timestampMs)
        )
      ) {
        throw new TraVideoProcessingError(
          'FFmpeg scene candidate files did not match the requested timestamps.',
          400,
          'FRAME_EXTRACTION_FAILED'
        );
      }

      const sourceVideoContentHash = toSha256(source.stored.buffer);
      const candidates = await Promise.all(
        sceneTimestampsMs.map((timestampMs, candidateIndex) =>
          materializeTemporaryCandidate({
            source,
            sourceVideoContentHash,
            policy: resolvedPolicy,
            candidateIndex,
            timestampMs,
            temporaryPath: path.join(temporaryDirectory, expectedFiles[candidateIndex]),
            extractionReasons: ['SCENE_CHANGE'],
            operation: 'scene',
          })
        )
      );
      completed = true;
      return { candidates, temporaryDirectory };
    } finally {
      if (!completed) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }
}
