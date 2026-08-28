import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectImageMimeType } from '@/lib/media/storage';
import { FfmpegTraVideoProcessor, TraVideoProcessingError } from '@/lib/video/ffmpeg';
import { REAL_ENCODED_MP4 } from '@/tests/fixtures/media';

afterEach(() => vi.unstubAllEnvs());

describe('trusted TRA video FFmpeg processor', () => {
  it('decodes a real encoded MP4 into a timestamped PNG frame', async () => {
    const result = await new FfmpegTraVideoProcessor().process(REAL_ENCODED_MP4, 'source.mp4', () => [0]);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0].timestampMs).toBe(0);
    expect(detectImageMimeType(result.frames[0].buffer)).toBe('image/png');
  });

  it('rejects corrupt or unsupported bytes during trusted decode probing', async () => {
    await expect(new FfmpegTraVideoProcessor().process(Buffer.from('not a decodable mp4'), 'source.mp4', () => [0])).rejects.toBeInstanceOf(TraVideoProcessingError);
  });
});
