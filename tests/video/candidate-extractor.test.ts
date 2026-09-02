import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HydratedCreativeSourceAsset } from '@/lib/media/source-hydration';
import { detectImageMimeType } from '@/lib/media/storage';
import {
  FfmpegIntervalCandidateExtractor,
  FfmpegSceneCandidateMaterializer,
  type HydratedTraVideoSource,
} from '@/lib/video/candidate-extractor';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import { runFfmpeg, TraVideoProcessingError } from '@/lib/video/ffmpeg';
import {
  REAL_MISMATCHED_STREAM_DURATION_MP4,
  REAL_MULTI_FRAME_MP4,
} from '@/tests/fixtures/media';

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

const jpegWithDimensions = (width: number, height: number) => {
  const jpeg = Buffer.from(VALID_JPEG);
  const sofMarker = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  if (sofMarker < 0) throw new Error('Test JPEG is missing a baseline SOF marker.');
  jpeg.writeUInt16BE(height, sofMarker + 5);
  jpeg.writeUInt16BE(width, sofMarker + 7);
  return jpeg;
};

const writeCandidateFiles = async (
  outputPattern: string,
  count: number,
  jpeg = VALID_JPEG
) => {
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      writeFile(
        outputPattern.replace('%06d', String(index).padStart(6, '0')),
        jpeg
      )
    )
  );
};

const probeResult = (durationMs: number, containerDuration: string) => ({
  stdout: Buffer.from(
    `out_time_us=${durationMs * 1000}\nout_time_ms=${durationMs * 1000}\nprogress=end\n`
  ),
  stderr: `Duration: ${containerDuration}`,
});

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

  it('bases duration and adaptive density on selected video when audio is longer', async () => {
    const result = await new FfmpegIntervalCandidateExtractor().extractCandidates(
      makeVideoSource(REAL_MISMATCHED_STREAM_DURATION_MP4)
    );
    successfulDirectories.push(result.temporaryDirectory);

    expect(result.durationMs).toBe(4_000);
    expect(result.effectiveIntervalFps).toBe(3);
    expect(result.candidates.length).toBeGreaterThanOrEqual(11);
    expect(result.candidates.length).toBeLessThanOrEqual(12);
    expect(result.candidates[0].timestampMs).toBe(0);
    expect(result.candidates.at(-1)!.timestampMs).toBeGreaterThanOrEqual(3_500);
    expect(result.candidates.at(-1)!.timestampMs).toBeLessThan(result.durationMs);
  });

  it('uses the adaptive long-video FPS and passes the hard batch limit to FFmpeg', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'candidate-test-'));
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('null')) {
        return probeResult(300_000, '00:05:00.00');
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

  it('preserves fractional-FPS showinfo timestamps at millisecond precision', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'candidate-test-'));
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('null')) {
        return probeResult(1_000, '00:00:01.00');
      }
      await writeCandidateFiles(args.at(-1)!, 4);
      return {
        stdout: Buffer.alloc(0),
        stderr: [
          '[Parsed_showinfo_2] n: 0 pts: 0 pts_time:0 duration:1',
          '[Parsed_showinfo_2] n: 1 pts: 1 pts_time:0.033367 duration:1',
          '[Parsed_showinfo_2] n: 2 pts: 2 pts_time:0.066733 duration:1',
          '[Parsed_showinfo_2] n: 3 pts: 3 pts_time:0.100100 duration:1',
        ].join('\n'),
      };
    });

    try {
      const result = await new FfmpegIntervalCandidateExtractor({
        run,
        temporaryRoot,
      }).extractCandidates(makeVideoSource(), {
        ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
        targetIntervalFps: 29.97,
        maxIntervalCandidates: 30,
        maxTotalCandidates: 30,
      });
      successfulDirectories.push(result.temporaryDirectory);

      expect(result.candidates.map((candidate) => candidate.timestampMs)).toEqual([
        0, 33, 67, 100,
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects timestamps at or beyond the probed duration', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'candidate-test-'));
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('null')) {
        return probeResult(1_000, '00:00:01.00');
      }
      await writeCandidateFiles(args.at(-1)!, 1);
      return {
        stdout: Buffer.alloc(0),
        stderr: '[Parsed_showinfo_2] n: 0 pts: 1 pts_time:1 duration:1',
      };
    });

    try {
      await expect(
        new FfmpegIntervalCandidateExtractor({ run, temporaryRoot }).extractCandidates(
          makeVideoSource()
        )
      ).rejects.toThrow('trustworthy timestamp metadata');
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('cleans partial candidate output when FFmpeg fails during extraction', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'candidate-test-'));
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('null')) {
        return probeResult(4_000, '00:00:04.00');
      }
      await writeFile(args.at(-1)!.replace('%06d', '000000'), VALID_JPEG);
      throw new Error('simulated FFmpeg extraction failure');
    });

    try {
      await expect(
        new FfmpegIntervalCandidateExtractor({ run, temporaryRoot }).extractCandidates(
          makeVideoSource()
        )
      ).rejects.toThrow('failed while extracting interval candidates');
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects FFmpeg output that exceeds the configured candidate cap', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'candidate-test-'));
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('null')) {
        return probeResult(4_000, '00:00:04.00');
      }
      await writeCandidateFiles(args.at(-1)!, 3);
      return { stdout: Buffer.alloc(0), stderr: '' };
    });

    try {
      await expect(
        new FfmpegIntervalCandidateExtractor({ run, temporaryRoot }).extractCandidates(
          makeVideoSource(),
          {
            ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
            maxIntervalCandidates: 2,
            maxTotalCandidates: 2,
          }
        )
      ).rejects.toThrow('exceeded the bounded interval candidate limit');
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('extracts short videos with in-range timestamps', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'candidate-test-'));
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('null')) {
        return probeResult(500, '00:00:00.50');
      }
      await writeCandidateFiles(args.at(-1)!, 1);
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

      expect(result.durationMs).toBe(500);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates.every((candidate) =>
        candidate.timestampMs >= 0 && candidate.timestampMs < result.durationMs
      )).toBe(true);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('extracts a real 100 ms video into a trustworthy temporary candidate', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'candidate-test-'));
    const shortVideoPath = path.join(temporaryRoot, 'short.mp4');

    try {
      await runFfmpeg([
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=80x48:r=30:d=0.1',
        '-map',
        '0:v:0',
        '-c:v',
        'mpeg4',
        shortVideoPath,
      ]);

      const result = await new FfmpegIntervalCandidateExtractor({
        temporaryRoot,
      }).extractCandidates(makeVideoSource(await readFile(shortVideoPath)));
      const candidate = result.candidates[0];
      const bytes = await readFile(candidate.temporaryPath);

      expect(result.durationMs).toBe(100);
      expect(result.candidates).toHaveLength(1);
      expect(detectImageMimeType(bytes)).toBe('image/jpeg');
      expect(candidate.timestampMs).toBeGreaterThanOrEqual(0);
      expect(candidate.timestampMs).toBeLessThan(result.durationMs);
      expect(candidate).toMatchObject({
        lifecycle: 'TEMPORARY',
        providerEligible: false,
        extractionReasons: ['INTERVAL'],
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('accepts portrait odd-dimension output scaled within maxWidth and preserves aspect ratio', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'candidate-test-'));
    const outputJpeg = jpegWithDimensions(400, 710);
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('null')) {
        return probeResult(2_000, '00:00:02.00');
      }
      await writeCandidateFiles(args.at(-1)!, 1, outputJpeg);
      return {
        stdout: Buffer.alloc(0),
        stderr: '[Parsed_showinfo_2] n: 0 pts: 0 pts_time:0 duration:1',
      };
    });

    try {
      const result = await new FfmpegIntervalCandidateExtractor({
        run,
        temporaryRoot,
      }).extractCandidates(makeVideoSource(), {
        ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
        maxWidth: 400,
      });
      successfulDirectories.push(result.temporaryDirectory);

      const candidate = result.candidates[0];
      expect(candidate.width).toBe(400);
      expect(candidate.height).toBe(710);
      expect(candidate.width).toBeLessThanOrEqual(400);
      expect(candidate.width / candidate.height).toBeCloseTo(721 / 1281, 2);
      expect(run.mock.calls[1][0][run.mock.calls[1][0].indexOf('-vf') + 1]).toContain(
        "scale=w='min(iw,400)':h=-2"
      );
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
        return probeResult(4_000, '00:00:04.00');
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
        return probeResult(4_000, '00:00:04.00');
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

describe('scene-change TRA video candidate materialization', () => {
  it('materializes one trusted scene timestamp into a temporary JPEG with source provenance', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'scene-candidate-test-'));
    try {
      const [candidate] = await new FfmpegSceneCandidateMaterializer({
        temporaryRoot,
      }).materializeCandidates(makeVideoSource(), [1_000], {
        ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
        maxWidth: 40,
      });
      successfulDirectories.push(path.dirname(candidate.temporaryPath));
      const bytes = await readFile(candidate.temporaryPath);

      expect(detectImageMimeType(bytes)).toBe('image/jpeg');
      expect(candidate).toMatchObject({
        candidateIndex: 0,
        timestampMs: 1_000,
        sourceRole: 'TRA_VIDEO',
        sourceVideoMediaId: MEDIA_ID,
        sourceVideoFileName: `${MEDIA_ID}.mp4`,
        sourceVideoContentHash: sha256(REAL_MULTI_FRAME_MP4),
        mimeType: 'image/jpeg',
        width: 40,
        height: 24,
        byteLength: bytes.length,
        frameSha256: sha256(bytes),
        extractionReasons: ['SCENE_CHANGE'],
        lifecycle: 'TEMPORARY',
        providerEligible: false,
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('maps ordered timestamps to matching bounded FFmpeg JPEG outputs', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'scene-candidate-test-'));
    const run = vi.fn(async (args: string[]) => {
      await writeCandidateFiles(args.at(-1)!, 2, jpegWithDimensions(400, 240));
      return {
        stdout: Buffer.alloc(0),
        stderr: [
          '[Parsed_showinfo_2] n: 0 pts: 125 pts_time:0.125 duration:1',
          '[Parsed_showinfo_2] n: 1 pts: 1250 pts_time:1.25 duration:1',
        ].join('\n'),
      };
    });
    try {
      const candidates = await new FfmpegSceneCandidateMaterializer({
        run,
        temporaryRoot,
      }).materializeCandidates(makeVideoSource(), [125, 1_250], {
        ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
        maxIntervalCandidates: 2,
        maxTotalCandidates: 2,
        maxWidth: 400,
        jpegQuality: 50,
      });
      successfulDirectories.push(path.dirname(candidates[0].temporaryPath));

      expect(candidates.map((candidate) => [candidate.candidateIndex, candidate.timestampMs])).toEqual([
        [0, 125], [1, 1_250],
      ]);
      expect(candidates.every((candidate) => candidate.width === 400 && candidate.height === 240)).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
      const extractionArgs = run.mock.calls[0][0];
      expect(extractionArgs[extractionArgs.indexOf('-frames:v') + 1]).toBe('2');
      expect(extractionArgs).not.toContain('-ss');
      expect(extractionArgs[extractionArgs.indexOf('-vf') + 1]).toContain('0.125');
      expect(extractionArgs[extractionArgs.indexOf('-vf') + 1]).toContain('1.25');
      expect(extractionArgs[extractionArgs.indexOf('-q:v') + 1]).toBe('17');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['FFmpeg fails', async (outputPattern: string) => { await writeFile(outputPattern.replace('%06d', '000000'), VALID_JPEG); throw new Error('failed'); }, /failed while extracting scene candidates/],
    ['JPEG is malformed', async (outputPattern: string) => { await writeFile(outputPattern.replace('%06d', '000000'), JPEG_HEADER_WITHOUT_SCAN); }, /invalid JPEG scene candidate/],
    ['output file does not match its timestamp', async (outputPattern: string) => { await writeFile(outputPattern.replace('%06d', '000001'), VALID_JPEG); }, /files did not match the requested timestamps/],
  ])('fails cleanly when %s', async (_, writeOutput, expectedError) => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'scene-candidate-test-'));
    const run = vi.fn(async (args: string[]) => {
      await writeOutput(args.at(-1)!);
      return {
        stdout: Buffer.alloc(0),
        stderr: '[Parsed_showinfo_2] n: 0 pts: 100 pts_time:0.1 duration:1',
      };
    });
    try {
      await expect(
        new FfmpegSceneCandidateMaterializer({ run, temporaryRoot }).materializeCandidates(
          makeVideoSource(),
          [100]
        )
      ).rejects.toThrow(expectedError);
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('enforces the total candidate bound before invoking FFmpeg', async () => {
    const run = vi.fn();
    await expect(
      new FfmpegSceneCandidateMaterializer({ run }).materializeCandidates(
        makeVideoSource(),
        [100, 200, 300],
        {
          ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
          maxIntervalCandidates: 2,
          maxTotalCandidates: 2,
        }
      )
    ).rejects.toThrow('Scene timestamps must be bounded');
    expect(run).not.toHaveBeenCalled();
  });
});
