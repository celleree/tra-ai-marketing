import { describe, expect, it, vi } from 'vitest';
import { HARD_MAX_TOTAL_CANDIDATES } from '@/lib/video/candidate-policy';
import {
  DEFAULT_SCENE_CHANGE_THRESHOLD,
  FfmpegSceneChangeDetector,
} from '@/lib/video/scene-change-detector';

const sceneOutput = (...timestamps: string[]) => ({
  stdout: Buffer.alloc(0),
  stderr: timestamps
    .map((timestamp, index) =>
      `[Parsed_showinfo_2] n: ${index} pts: ${index} pts_time:${timestamp}`
    )
    .join('\n'),
});

const showinfoConfig = [
  '[Parsed_showinfo_2 @ 0x123] config in time_base: 1/90000, frame_rate: 30/1',
  '[Parsed_showinfo_2 @ 0x123] config out time_base: 0/0, frame_rate: 0/0',
].join('\n');

const detectorFor = (result = sceneOutput('0.1')) => {
  const run = vi.fn(async (_args: string[]) => result);
  return { detector: new FfmpegSceneChangeDetector({ run }), run };
};

describe('FFmpeg scene-change timestamp detection', () => {
  it('returns ordered integer-millisecond scene timestamps', async () => {
    const { detector } = detectorFor(sceneOutput('0.1004', '1.25', '3.9994'));
    await expect(detector.detect('/tmp/source.mp4', 4_000, 10)).resolves.toEqual([
      100, 1_250, 3_999,
    ]);
  });

  it('returns no timestamps when no scenes are selected', async () => {
    const { detector } = detectorFor(sceneOutput());
    await expect(detector.detect('/tmp/source.mp4', 4_000, 10)).resolves.toEqual([]);
  });

  it('ignores showinfo configuration before valid frame metadata', async () => {
    const { detector } = detectorFor({
      stdout: Buffer.alloc(0),
      stderr: `${showinfoConfig}\n${sceneOutput('0.5', '1.25').stderr}`,
    });
    await expect(detector.detect('/tmp/source.mp4', 2_000, 10)).resolves.toEqual([
      500, 1_250,
    ]);
  });

  it('returns no timestamps for configuration-only showinfo output', async () => {
    const { detector } = detectorFor({ stdout: Buffer.alloc(0), stderr: showinfoConfig });
    await expect(detector.detect('/tmp/source.mp4', 2_000, 10)).resolves.toEqual([]);
  });

  it('deduplicates rounding collisions deterministically', async () => {
    const { detector } = detectorFor(sceneOutput('0.1001', '0.1004', '0.101'));
    await expect(detector.detect('/tmp/source.mp4', 1_000, 10)).resolves.toEqual([
      100, 101,
    ]);
  });

  it('fails closed when FFmpeg reports more detections than the bound', async () => {
    const { detector } = detectorFor(sceneOutput('0.1', '0.2', '0.3'));
    await expect(detector.detect('/tmp/source.mp4', 1_000, 2)).rejects.toThrow(
      'exceeded the bounded scene-change detection limit'
    );
  });

  it.each([
    ['malformed metadata', '[Parsed_showinfo_2] n: 0'],
    ['frame metadata without pts_time', '[Parsed_showinfo_2] n: 0 pts: 0'],
    ['negative timestamp', sceneOutput('-0.1').stderr],
    ['timestamp at duration', sceneOutput('4').stderr],
    ['nonchronological metadata', sceneOutput('2', '1').stderr],
  ])('fails closed for %s', async (_, stderr) => {
    const { detector } = detectorFor({ stdout: Buffer.alloc(0), stderr });
    await expect(detector.detect('/tmp/source.mp4', 4_000, 10)).rejects.toThrow(
      /scene-change timestamp metadata/
    );
  });

  it('validates detection limits and thresholds', async () => {
    const { detector } = detectorFor();
    await expect(detector.detect('/tmp/source.mp4', 1_000, 0)).rejects.toThrow(
      'maxDetections must be a positive integer'
    );
    await expect(detector.detect('/tmp/source.mp4', 1_000, HARD_MAX_TOTAL_CANDIDATES + 1)).rejects.toThrow(
      'hard system limit'
    );
    await expect(detector.detect('/tmp/source.mp4', 1_000, 1, 0)).rejects.toThrow(
      'threshold'
    );
  });

  it('uses the configured threshold, bounds FFmpeg, and writes no frames', async () => {
    const { detector, run } = detectorFor(sceneOutput('0.5'));
    await expect(detector.detect('/tmp/source.mp4', 1_000, 3, 0.65)).resolves.toEqual([500]);
    const args = run.mock.calls[0][0];
    expect(args[args.indexOf('-vf') + 1]).toContain("gt(scene,0.65)");
    expect(args[args.indexOf('-frames:v') + 1]).toBe('3');
    expect(args).toEqual(expect.arrayContaining(['-f', 'null', '-']));
    expect(args.some((arg: string) => /jpe?g|image2/i.test(arg))).toBe(false);
    expect(DEFAULT_SCENE_CHANGE_THRESHOLD).toBe(0.4);
  });

  it('propagates unavailable FFmpeg and normalizes FFmpeg failures', async () => {
    const unavailable = new FfmpegSceneChangeDetector({
      run: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
    });
    await expect(unavailable.detect('/tmp/source.mp4', 1_000, 1)).rejects.toThrow('unavailable');
    const failed = new FfmpegSceneChangeDetector({ run: vi.fn(async () => { throw new Error('failed'); }) });
    await expect(failed.detect('/tmp/source.mp4', 1_000, 1)).rejects.toThrow('failed while detecting scene changes');
  });
});
