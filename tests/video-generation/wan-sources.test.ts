import { describe, expect, it, vi } from 'vitest';
import * as ffmpeg from '@/lib/video/ffmpeg';
import { readFile } from 'node:fs/promises';
import { probeWanVideo, loadWanSources } from '@/lib/video-generation/wan/sources';
import { createVideoResponse } from '@/lib/media/video-response';
import { wanRoute } from '@/lib/video-generation/wan/route';
import { getOperatorAccess } from '@/lib/auth/server-access';
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: vi.fn() }));

describe('Wan physical source probe and protected delivery', () => {
  it('counts actual decoded frames of the existing synthetic MP4 fixture', async () => {
    const bytes = await readFile('tests/fixtures/video-review-preview-pool.mp4');
    expect(await probeWanVideo(bytes)).toEqual({ frames: 32, durationMs: 8000 });
  }, 20_000);
  it('blocks decoded frame overflow, metadata duration overflow and decoded duration overflow', async () => {
    for (const [frames, metadataSeconds, decodedUs] of [[1801, '08', 8000000], [32, '31', 31000000], [32, '08', 31000000]]) {
      vi.spyOn(ffmpeg, 'runFfmpeg').mockResolvedValueOnce({ stdout: Buffer.from(`frame=${frames}\nout_time_us=${decodedUs}\nprogress=end\n`), stderr: `Duration: 00:00:${metadataSeconds}.00` });
      await expect(probeWanVideo(Buffer.from('fixture'))).rejects.toThrow('at most');
      vi.restoreAllMocks();
    }
  });
  it('rejects arbitrary URLs/IDs and corrupt MP4', async () => {
    await expect(loadWanSources('https://evil.test/image', 'https://evil.test/source')).rejects.toThrow('stored');
    await expect(probeWanVideo(Buffer.from('corrupt mp4'))).rejects.toThrow();
  });
  it('authenticates before accessing jobs and scopes successful access to Clerk userId', async () => {
    const operation = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.mocked(getOperatorAccess).mockResolvedValue({ allowed: false, status: 401, error: 'Sign in required.' });
    expect((await wanRoute(operation)).status).toBe(401); expect(operation).not.toHaveBeenCalled();
    vi.mocked(getOperatorAccess).mockResolvedValue({ allowed: true, userId: 'clerk-operator' });
    expect((await wanRoute(operation)).status).toBe(200); expect(operation).toHaveBeenCalledWith('clerk-operator');
  });
  it('streams private MP4 ranges, suffix ranges and rejects invalid offsets', async () => {
    const bytes = Buffer.from('0123456789');
    const response = createVideoResponse(bytes, new Request('https://app/output', { headers: { Range: 'bytes=2-5' } }));
    expect(response.status).toBe(206); expect(await response.text()).toBe('2345'); expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const suffix = createVideoResponse(bytes, new Request('https://app/output', { headers: { Range: 'bytes=-3' } })); expect(await suffix.text()).toBe('789');
    expect(createVideoResponse(bytes, new Request('https://app/output', { headers: { Range: 'bytes=100-' } })).status).toBe(416);
  });
});
