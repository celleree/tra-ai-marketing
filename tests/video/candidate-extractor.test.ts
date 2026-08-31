import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HydratedCreativeSourceAsset } from '@/lib/media/source-hydration';
import { detectImageMimeType } from '@/lib/media/storage';
import {
  FfmpegIntervalCandidateExtractor,
  type HydratedTraVideoSource,
} from '@/lib/video/candidate-extractor';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import { TraVideoProcessingError } from '@/lib/video/ffmpeg';
import { REAL_MULTI_FRAME_MP4 } from '@/tests/fixtures/media';

const MEDIA_ID = `media_${'a'.repeat(32)}`;
const VALID_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYxLjMuMTAwAP/bAEMACAoKCwoLDQ0NDQ0NEA8QEBAQEBAQEBAQEBISEhUVFRISEhAQEhIUFBUVFxcXFRUVFRcXGRkZHh4cHCMjJCsrM//EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsAUX9//9k=',
  'base64'
);
const JPEG_HEADER_WITHOUT_SCAN = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x02, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xd9,
]);
const successfulDirectories: string[] = [];

const sha256 = (buffer: Buffer) =>
  createHash('sha256').update(buffer).digest('hex');

const makeVideoSource = (
  buffer = REAL_MULTI_FRAME_MP4
): HydratedTraVideoSource =>
  ({
    role: 'TRA_VIDEO',
    media: {
      id: MEDIA_ID,
      fileName: `${MEDIA_ID}.mp4`,
      mimeType: 'video/mp4',
      mediaType: 'VIDEO',
      size: buffer.length,
      url: `/api/media/files/${MEDIA_ID}.mp4`,
    },
    stored: {
      fileName: `${MEDIA_ID}.mp4`,
      buffer,
      mimeType: 'video/mp4',
      mediaType: 'VIDEO',
    },
  }) as HydratedTraVideoSource;

afterEach(async () => {
  await Promise.all(
    successfulDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
  vi.restoreAllMocks();
});

describe('dense interval TRA video candidate extraction', () => {
  it('extracts one trustworthy JPEG batch with bounded temporary provenance', async () => {
    const policy = {
      ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
      maxWidth: 40,
    };
    const result = await new FfmpegIntervalCandidateExtractor().extractCandidates(
      makeVideoSource(),
      policy
    );
    successfulDirectories.push(result.temporaryDirectory);

    expect(result.durationMs).toBe(4_000);
    expect(result.effectiveIntervalFps).toBe(3);
    expect(result.candidates.length).toBeGreaterThanOrEqual(11);
    expect(result.candidates.length).toBeLessThanOrEqual(12);
    expect(result.candidates[0].timestampMs).toBe(0);
    expect(result.candidates.at(-1)!.timestampMs).toBeGreaterThanOrEqual(3_500);
    expect(result.candidates.map((candidate) => candidate.candidateIndex)).toEqual(
      result.candidates.map((_, index) => index)
    );
    expect(
      result.candidates.every(
        (candidate, index) =>
          index === 0 ||
          candidate.timestampMs > result.candidates[index - 1].timestampMs
      )
    ).toBe(true);

    const sourceHash = sha256(REAL_MULTI_FRAME_MP4);
    for (const candidate of result.candidates) {
      const bytes = await readFile(candidate.temporaryPath);
      expect(detectImageMimeType(bytes)).toBe('image/jpeg');
      expect(candidate).toMatchObject({
        sourceRole: 'TRA_VIDEO',
        sourceVideoMediaId: MEDIA_ID,
        sourceVideoFileName: `${MEDIA_ID}.mp4`,
        sourceVideoContentHash: sourceHash,
        mimeType: 'image/jpeg',
        width: 40,
        height: 24,
        byteLength: bytes.length,
        frameSha256: sha256(bytes),
        extractionReasons: ['INTERVAL'],
        lifecycle: 'TEMPORARY',
        providerEligible: false,
      });
    }
  });

  it('honors a valid custom FPS policy through the same interval batch', async () => {
    const result = await new FfmpegIntervalCandidateExtractor().extractCandidates(
      makeVideoSource(),
      { ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, targetIntervalFps: 1 }
    );
    successfulDirectories.push(result.temporaryDirectory);

    expect(result.effectiveIntervalFps).toBe(1);
    expect(result.candidates).toHaveLength(4);
    expect(result.candidates.map((candidate) => candidate.timestampMs)).toEqual([
      0, 1_000, 2_000, 3_000,
    ]);
    expect(result.candidates.every((candidate) => candidate.width === 80)).toBe(true);
    expect(result.candidates.every((candidate) => candidate.height === 48)).toBe(true);
  });

  it('uses the adaptive long-video FPS and passes the hard batch limit to FFmpeg', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'candidate-test-'));
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('null')) {
        return {
          stdout: Buffer.alloc(0),
          stderr:
            'Duration: 00:05:00.00\n  Stream #0:0: Video: mpeg4, yuv420p, 80x48',
        };
      }
      const outputPattern = args.at(-1)!;
      await writeFile(outputPattern.replace('%06d', '000000'), VALID_JPEG);
      return {
        stdout: Buffer.alloc(0),
        stderr: '[Parsed_showinfo_2] n: 0 pts: 0 pts_time:0 duration:1',
      };
    });

    try {
      const result = await new FfmpegIntervalCandidateExtractor({
        run,
        temporaryRoot,
      }).extractCandidates(makeVideoSource());
      successfulDirectories.push(result.temporaryDirectory);

      expect(run).toHaveBeenCalledTimes(2);
      expect(result.effectiveIntervalFps).toBeCloseTo(1.2);
      const extractionArgs = run.mock.calls[1][0];
      expect(extractionArgs[extractionArgs.indexOf('-frames:v') + 1]).toBe('360');
      expect(extractionArgs[extractionArgs.indexOf('-vf') + 1]).toContain('fps=1.2');
      expect(result.candidates.length).toBeLessThanOrEqual(360);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects corrupt video bytes and removes the failed temporary work', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'candidate-test-'));
    try {
      await expect(
        new FfmpegIntervalCandidateExtractor({ temporaryRoot }).extractCandidates(
          makeVideoSource(Buffer.from('not a decodable mp4'))
        )
      ).rejects.toBeInstanceOf(TraVideoProcessingError);
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects malformed partial JPEG output and cleans the partial batch', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'candidate-test-'));
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('null')) {
        return {
          stdout: Buffer.alloc(0),
          stderr:
            'Duration: 00:00:04.00\n  Stream #0:0: Video: mpeg4, yuv420p, 80x48',
        };
      }
      await writeFile(
        args.at(-1)!.replace('%06d', '000000'),
        JPEG_HEADER_WITHOUT_SCAN
      );
      return {
        stdout: Buffer.alloc(0),
        stderr: '[Parsed_showinfo_2] n: 0 pts: 0 pts_time:0 duration:1',
      };
    });

    try {
      await expect(
        new FfmpegIntervalCandidateExtractor({
          run,
          temporaryRoot,
        }).extractCandidates(makeVideoSource())
      ).rejects.toThrow('invalid JPEG interval candidate');
      expect(run).toHaveBeenCalledTimes(2);
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('fails on timestamp/file-count mismatch instead of accepting bad provenance', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'candidate-test-'));
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('null')) {
        return {
          stdout: Buffer.alloc(0),
          stderr:
            'Duration: 00:00:04.00\n  Stream #0:0: Video: mpeg4, yuv420p, 80x48',
        };
      }
      await writeFile(args.at(-1)!.replace('%06d', '000000'), VALID_JPEG);
      return { stdout: Buffer.alloc(0), stderr: '' };
    });

    try {
      await expect(
        new FfmpegIntervalCandidateExtractor({
          run,
          temporaryRoot,
        }).extractCandidates(makeVideoSource())
      ).rejects.toThrow('trustworthy timestamp metadata');
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects non-TRA-video sources before invoking FFmpeg', async () => {
    const run = vi.fn();
    const source = {
      ...makeVideoSource(),
      role: 'LAYOUT_REFERENCE',
    } as unknown as HydratedCreativeSourceAsset;

    await expect(
      new FfmpegIntervalCandidateExtractor({ run }).extractCandidates(
        source as HydratedTraVideoSource
      )
    ).rejects.toThrow('server-hydrated TRA_VIDEO MP4');
    expect(run).not.toHaveBeenCalled();
  });
});
