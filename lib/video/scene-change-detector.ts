import { HARD_MAX_TOTAL_CANDIDATES } from '@/lib/video/candidate-policy';
import { runFfmpeg, TraVideoProcessingError } from '@/lib/video/ffmpeg';

export const DEFAULT_SCENE_CHANGE_THRESHOLD = 0.4;

type FfmpegRunner = typeof runFfmpeg;

export interface SceneChangeDetector {
  detect(
    inputPath: string,
    durationMs: number,
    maxDetections: number,
    threshold?: number
  ): Promise<number[]>;
}

interface FfmpegSceneChangeDetectorDependencies {
  run?: FfmpegRunner;
}

const fail = (message: string): never => {
  throw new TraVideoProcessingError(message, 400, 'FRAME_EXTRACTION_FAILED');
};

const validateInputs = (
  durationMs: number,
  maxDetections: number,
  threshold: number
) => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('Scene detection durationMs must be a positive number.');
  }
  if (!Number.isInteger(maxDetections) || maxDetections < 1) {
    throw new Error('Scene detection maxDetections must be a positive integer.');
  }
  if (maxDetections > HARD_MAX_TOTAL_CANDIDATES) {
    throw new Error(
      `Scene detection maxDetections must not exceed the hard system limit of ${HARD_MAX_TOTAL_CANDIDATES}.`
    );
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error('Scene detection threshold must be a number greater than 0 and at most 1.');
  }
};

const parseSceneTimestamps = (stderr: string, durationMs: number) => {
  const timestamps: number[] = [];
  let previousSeconds = -1;
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes('Parsed_showinfo')) continue;
    const timestamp = line.match(/\bpts_time:\s*(-?\d+(?:\.\d+)?)/)?.[1];
    if (timestamp === undefined) {
      fail('FFmpeg returned malformed scene-change timestamp metadata.');
    }
    const seconds = Number(timestamp);
    const timestampMs = Math.round(seconds * 1000);
    if (
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds < previousSeconds ||
      !Number.isSafeInteger(timestampMs) ||
      timestampMs < 0 ||
      timestampMs >= durationMs
    ) {
      fail('FFmpeg returned untrustworthy scene-change timestamp metadata.');
    }
    previousSeconds = seconds;
    if (timestamps.at(-1) !== timestampMs) timestamps.push(timestampMs);
  }
  return timestamps;
};

export class FfmpegSceneChangeDetector implements SceneChangeDetector {
  private readonly run: FfmpegRunner;

  constructor(dependencies: FfmpegSceneChangeDetectorDependencies = {}) {
    this.run = dependencies.run || runFfmpeg;
  }

  async detect(
    inputPath: string,
    durationMs: number,
    maxDetections: number,
    threshold = DEFAULT_SCENE_CHANGE_THRESHOLD
  ) {
    validateInputs(durationMs, maxDetections, threshold);
    let result;
    try {
      result = await this.run([
        '-hide_banner', '-nostdin', '-v', 'info', '-i', inputPath,
        '-map', '0:v:0', '-vf', `select='gt(scene,${threshold})',showinfo`,
        '-frames:v', String(maxDetections), '-an', '-f', 'null', '-',
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('FFmpeg runtime is unavailable for TRA scene detection.');
      }
      throw new TraVideoProcessingError(
        'The TRA video failed while detecting scene changes.',
        400,
        'FRAME_EXTRACTION_FAILED'
      );
    }
    const timestamps = parseSceneTimestamps(result.stderr, durationMs);
    if (timestamps.length > maxDetections) {
      fail('FFmpeg exceeded the bounded scene-change detection limit.');
    }
    return timestamps;
  }
}
