import { describe, expect, it, vi } from 'vitest';
import { uploadTraVideo } from '@/lib/video/upload-client';

const file = new File(['synthetic mp4'], 'fixture.mp4', { type: 'video/mp4' });
const media = { id: `media_${'a'.repeat(32)}`, fileName: 'fixture.mp4', originalName: file.name,
  url: '/api/media/files/fixture.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', size: file.size };
const plan = { direct: true, uploadUrl: 'https://preview-storage.example/upload', media, sourceRole: 'TRA_VIDEO' };

describe('TRA video client upload', () => {
  it('uploads bytes directly and confirms the stored TRA video before returning it', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(plan))
      .mockResolvedValueOnce(new Response(null, { status: 200 })).mockResolvedValueOnce(Response.json({ ok: true }));
    expect(await uploadTraVideo(file, request)).toEqual(media);
    expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/media/upload-url', plan.uploadUrl, '/api/media/confirm']);
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({ fileName: file.name, mimeType: file.type, size: file.size, sourceRole: 'TRA_VIDEO' });
    expect(request.mock.calls[1][1]).toEqual({ method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: file });
    expect(JSON.parse(request.mock.calls[2][1]!.body as string)).toEqual({ mediaId: media.id, mimeType: 'video/mp4', mediaType: 'VIDEO', sourceRole: 'TRA_VIDEO' });
  });

  it('uses the server fallback only when the plan explicitly disables direct upload', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ direct: false }))
      .mockResolvedValueOnce(Response.json({ ...media, sourceRole: 'TRA_VIDEO' }));
    expect(await uploadTraVideo(file, request)).toMatchObject(media);
    expect(request.mock.calls[1][0]).toBe('/api/media/upload');
    const form = request.mock.calls[1][1]!.body as FormData;
    expect(form.get('sourceRole')).toBe('TRA_VIDEO');
    expect((form.get('file') as File).name).toBe(file.name);
  });

  it.each([
    {}, { ...plan, uploadUrl: undefined }, { ...plan, sourceRole: 'TRA_REFERENCE' },
    { ...plan, media: { ...media, mediaType: 'IMAGE' } },
  ])('rejects incomplete or mismatched plans without uploading', async (payload) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(payload));
    await expect(uploadTraVideo(file, request)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not fall back after plan, PUT, or confirmation failure', async () => {
    for (const failureAt of [0, 1, 2]) {
      const responses = [Response.json(plan), new Response(null), Response.json({ ok: true })];
      responses[failureAt] = Response.json({ error: 'Unavailable' }, { status: 503 });
      const request = vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!);
      await expect(uploadTraVideo(file, request)).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(failureAt + 1);
      expect(request.mock.calls.some(([url]) => url === '/api/media/upload')).toBe(false);
    }
  });
});
