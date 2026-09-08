import { describe, expect, it, vi } from 'vitest';
import { createVideoResponse } from '@/lib/media/video-response';

const storage = vi.hoisted(() => ({ readMedia: vi.fn() }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: () => storage }));
import { GET } from '@/app/api/media/files/[fileName]/route';

const bytes = Uint8Array.from({ length: 10 }, (_, index) => index);
const request = (range?: string, extra: Record<string, string> = {}) => new Request('http://localhost/video.mp4', {
  headers: { ...(range ? { Range: range } : {}), ...extra },
});

describe('private video response', () => {
  it('streams a video larger than 4.5 MB in bounded chunks with identical bytes', async () => {
    const large = new Uint8Array(6 * 1024 * 1024 + 3).fill(23);
    const response = createVideoResponse(large, request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(String(large.length));
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    const reader = response.body!.getReader(); let length = 0; let chunks = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      expect(next.value.length).toBeLessThanOrEqual(64 * 1024);
      expect(next.value.every((value) => value === 23)).toBe(true);
      length += next.value.length; chunks += 1;
    }
    expect(length).toBe(large.length); expect(chunks).toBeGreaterThan(1);
  });

  it.each([['bytes=2-4', 2, 4], ['bytes=7-', 7, 9], ['bytes=-3', 7, 9], ['bytes=8-100', 8, 9], ['bytes=-100', 0, 9]])(
    'serves %s as a single partial response', async (range, start, end) => {
      const response = createVideoResponse(bytes, request(range));
      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/10`);
      expect(response.headers.get('Content-Length')).toBe(String(end - start + 1));
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(start, end + 1));
    });

  it.each(['bytes=10-', 'bytes=7-2', 'bytes=-0'])('rejects unsatisfiable range %s', async (range) => {
    const response = createVideoResponse(bytes, request(range));
    expect(response.status).toBe(416); expect(response.headers.get('Content-Range')).toBe('bytes */10');
    expect(await response.text()).toBe('');
  });

  it.each(['bytes=0-1,4-5', 'items=0-2', 'bytes=oops', 'bytes=-'])('ignores unsupported range %s', async (range) => {
    const response = createVideoResponse(bytes, request(range));
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('falls back to the full representation for If-Range without a validator', async () => {
    expect(createVideoResponse(bytes, request('bytes=0-1', { 'If-Range': '"old"' })).status).toBe(200);
  });

  it('routes MP4 playback through streaming while preserving image and missing-file behavior', async () => {
    const context = { params: Promise.resolve({ fileName: 'fixture.mp4' }) };
    storage.readMedia.mockResolvedValueOnce({ mimeType: 'video/mp4', buffer: bytes });
    const video = await GET(request('bytes=2-3'), context);
    expect(video.status).toBe(206); expect(new Uint8Array(await video.arrayBuffer())).toEqual(bytes.slice(2, 4));
    storage.readMedia.mockResolvedValueOnce({ mimeType: 'image/png', buffer: bytes });
    const image = await GET(request('bytes=2-3'), context);
    expect(image.status).toBe(200); expect(image.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
    storage.readMedia.mockResolvedValueOnce(null);
    expect((await GET(request(), context)).status).toBe(404);
  });
});
