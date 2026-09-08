import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectImageMimeType } from '@/lib/media/storage';

const FFMPEG_TIMEOUT_MS = 45_000;

export class TraVideoProcessingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code: 'UNSUPPORTED_OR_CORRUPT_VIDEO' | 'FRAME_EXTRACTION_FAILED' =
      'UNSUPPORTED_OR_CORRUPT_VIDEO'
  ) {
    super(message);
    this.name = 'TraVideoProcessingError';
  }
}

export interface VideoProcessResult {
  durationMs: number;
  frames: Array<{ timestampMs: number; buffer: Buffer }>;
}

export interface TraVideoProcessor {
  process(
    video: Buffer,
    fileName: string,
    selectTimestamps: (durationMs: number) => number[]
  ): Promise<VideoProcessResult>;
}

const getFfmpegPath = () =>
  process.env.FFMPEG_BIN?.trim() ||
  path.join(
    process.cwd(),
    '.runtime',
    'ffmpeg',
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  );

export const runFfmpeg = async (args: string[]) =>
  new Promise<{ stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ getFfmpegPath(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        child.kill('SIGKILL');
      }
    }, FFMPEG_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (signal) {
        const error = new Error(
          timedOut
            ? 'FFmpeg exceeded the TRA video-processing time limit.'
            : `FFmpeg terminated before completion (${signal}).`
        );
        Object.assign(error, { ffmpegTimedOut: timedOut });
        reject(error);
        return;
      }
      if (code !== 0) {
        const error = new Error(`FFmpeg exited with code ${code}.`);
        Object.assign(error, { ffmpegStderr: stderrText });
        reject(error);
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: stderrText });
    });
  });

export const parseFfmpegDurationMs = (stderr: string) => {
  const match = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const durationMs = Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;
};

/** Decodes the selected video stream while reading the container stream metadata.
 * A missing or unrecognizable probe is deliberately an error: only an explicit
 * absence of an audio stream may bypass transcription. */
export const probeTraVideoAudioTrack = async (video: Buffer) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'tra-video-audio-probe-'));
  const inputPath = path.join(workDir, 'source.mp4');
  try {
    await writeFile(inputPath, video);
    let result;
    try {
      result = await runFfmpeg([
        '-hide_banner', '-nostdin', '-v', 'info', '-i', inputPath,
        '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-',
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('FFmpeg runtime is unavailable for TRA video transcription probing.');
      }
      throw new Error('The hydrated TRA video could not be decoded for transcription probing.');
    }
    if (!/Stream\s+#\d+:\d+.*Video:/i.test(result.stderr)) {
      throw new Error('The hydrated TRA video has no recognizable video-stream metadata for transcription probing.');
    }
    return { hasAudioTrack: /Stream\s+#\d+:\d+.*Audio:/i.test(result.stderr) };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

const toTimestampArg = (timestampMs: number) => (timestampMs / 1000).toFixed(3);

export class FfmpegTraVideoProcessor implements TraVideoProcessor {
  async process(
    video: Buffer,
    fileName: string,
    selectTimestamps: (durationMs: number) => number[]
  ): Promise<VideoProcessResult> {
    const workDir = await mkdtemp(path.join(tmpdir(), 'tra-video-'));
    void fileName;
    const inputPath = path.join(workDir, 'source.mp4');

    try {
      await writeFile(inputPath, video);

      let probe;
      try {
        probe = await runFfmpeg([
          '-hide_banner',
          '-nostdin',
          '-v',
          'info',
          '-i',
          inputPath,
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-f',
          'null',
          '-',
        ]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('FFmpeg runtime is unavailable for TRA video preprocessing.');
        }
        throw new TraVideoProcessingError(
          'The TRA video could not be decoded. Upload a supported, non-corrupt MP4 video.'
        );
      }

      const durationMs = parseFfmpegDurationMs(probe.stderr);
      if (!durationMs || !/Stream\s+#\d+:\d+.*Video:/i.test(probe.stderr)) {
        throw new TraVideoProcessingError(
          'The TRA video does not contain a decodable video stream with a usable duration.'
        );
      }

      const timestamps = selectTimestamps(durationMs);
      if (!timestamps.length) {
        throw new TraVideoProcessingError(
          'The TRA video is too short to extract representative frames.'
        );
      }

      const frames: VideoProcessResult['frames'] = [];
      for (const timestampMs of timestamps) {
        let extracted: Buffer;
        try {
          const result = await runFfmpeg([
            '-hide_banner',
            '-nostdin',
            '-v',
            'error',
            '-i',
            inputPath,
            '-ss',
            toTimestampArg(timestampMs),
            '-map',
            '0:v:0',
            '-frames:v',
            '1',
            '-vf',
            'scale=w=1280:h=-2:force_original_aspect_ratio=decrease',
            '-f',
            'image2pipe',
            '-vcodec',
            'png',
            'pipe:1',
          ]);
          extracted = result.stdout;
        } catch {
          throw new TraVideoProcessingError(
            `The TRA video failed while extracting the representative frame at ${timestampMs}ms.`,
            400,
            'FRAME_EXTRACTION_FAILED'
          );
        }

        if (detectImageMimeType(extracted) !== 'image/png') {
          throw new TraVideoProcessingError(
            `The TRA video produced an invalid representative frame at ${timestampMs}ms.`,
            400,
            'FRAME_EXTRACTION_FAILED'
          );
        }
        frames.push({ timestampMs, buffer: extracted });
      }

      return { durationMs, frames };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
