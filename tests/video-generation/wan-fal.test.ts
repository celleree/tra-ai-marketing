import { describe, expect, it, vi } from 'vitest';
import { FalWanProvider, validateWanReceipt } from '@/lib/video-generation/wan/fal';
const id = '12345678-1234-1234-1234-123456789abc';
const queued = { request_id: id, status_url: `https://queue.fal.run/fal-ai/wan/requests/${id}/status`, response_url: `https://queue.fal.run/fal-ai/wan/requests/${id}` };
function mp4() {
  const box = (type: string, data: Buffer) => { const b = Buffer.alloc(8); b.writeUInt32BE(8 + data.length); b.write(type, 4); return Buffer.concat([b, data]); };
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov', Buffer.from('x')), box('mdat', Buffer.from('x'))]);
}
describe('Fal Wan private server transport', () => {
  it.each(['MOVE', 'REPLACE'] as const)('submits %s exact schema and privacy headers once', async mode => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(queued)); const provider = new FalWanProvider('dummy-key', request);
    await provider.submit(mode, '480p', 'https://r2/image?signed=secret', 'https://r2/source?signed=secret');
    const [url, options] = request.mock.calls[0]; expect(url).toBe(`https://queue.fal.run/fal-ai/wan/v2.2-14b/animate/${mode.toLowerCase()}`);
    expect(JSON.parse(options!.body as string)).toEqual({ image_url: 'https://r2/image?signed=secret', video_url: 'https://r2/source?signed=secret', resolution: '480p', enable_safety_checker: true, enable_output_safety_checker: true });
    const headers = options!.headers as Record<string, string>;
    expect(headers['X-Fal-No-Retry']).toBe('1'); expect(headers['X-Fal-Store-IO']).toBe('0'); expect(headers['X-Fal-Request-Start-Timeout']).toBe('60');
    expect(JSON.parse(headers['X-Fal-Object-Lifecycle-Preference'])).toEqual({ expiration_duration_seconds: 3600, initial_acl: { default: 'forbid', rules: [] } });
    expect(options!.redirect).toBe('error'); expect(request).toHaveBeenCalledTimes(1);
  });
  it('accepts normalized or exact model receipts; rejects unrelated origin, model, request, credentials and query', () => {
    expect(validateWanReceipt(queued, 'MOVE').requestId).toBe(id);
    expect(validateWanReceipt({ ...queued, status_url: queued.status_url.replace('/fal-ai/wan/', '/fal-ai/wan/v2.2-14b/animate/move/') }, 'MOVE')).toBeTruthy();
    for (const status_url of [queued.status_url.replace('queue.fal.run', 'evil.test'), queued.status_url.replace('/wan/', '/flux/'), queued.status_url.replace(id, 'different'), `${queued.status_url}?key=secret`, queued.status_url.replace('https://', 'https://evil:secret@'), queued.status_url.replace('/wan/', '/wan/v2.2-14b/animate/replace/')]) expect(() => validateWanReceipt({ ...queued, status_url }, 'MOVE')).toThrow();
  });
  it('does not retry network or non-success paid submission', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout')); const provider = new FalWanProvider('dummy', request);
    await expect(provider.submit('MOVE', '480p', 'image', 'video')).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
    request.mockReset().mockResolvedValue(new Response('error', { status: 503 })); await expect(provider.submit('MOVE', '480p', 'image', 'video')).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
  });
  it('treats completed error/error_type as failed; rejects wrong status request binding', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ request_id: id, status: 'COMPLETED', error_type: 'timeout' }));
    const provider = new FalWanProvider('dummy', request); const receipt = validateWanReceipt(queued, 'MOVE');
    expect(await provider.poll(receipt, 'MOVE')).toEqual({ state: 'FAILED' });
    request.mockResolvedValue(Response.json({ request_id: 'wrong', status: 'COMPLETED' })); await expect(provider.poll(receipt, 'MOVE')).rejects.toThrow();
  });
  it('exchanges a short-lived token and sends only Bearer to restricted CDN', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ video: { url: 'https://v3b.fal.media/files/b/test.mp4', content_type: 'video/mp4' } }))
      .mockResolvedValueOnce(Response.json({ token: 'short-lived-token', expires_at: '2099-01-01' }))
      .mockResolvedValueOnce(new Response(mp4(), { headers: { 'Content-Type': 'video/mp4' } }));
    const provider = new FalWanProvider('private-key', request);
    expect(await provider.download(validateWanReceipt(queued, 'MOVE'), 'MOVE')).toEqual(mp4());
    expect(request.mock.calls[1][0]).toBe('https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3');
    expect(JSON.parse(request.mock.calls[1][1]!.body as string)).toEqual({ expiration_seconds: 300 });
    expect(request.mock.calls[2][1]!.headers).toEqual({ Authorization: 'Bearer short-lived-token' });
    expect(request.mock.calls[2][1]!.redirect).toBe('error');
  });
  it.each(['https://evil.test/files/b/test.mp4', 'https://v3b.fal.media.evil.test/files/b/test.mp4', 'http://v3b.fal.media/files/b/test.mp4', 'https://v3b.fal.media/private.json'])('rejects output destination %s before exchanging credentials', async url => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ video: { url, content_type: 'video/mp4' } }));
    await expect(new FalWanProvider('dummy', request).download(validateWanReceipt(queued, 'MOVE'), 'MOVE')).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(['wrong-mime', 'oversize', 'invalid-mp4', 'redirect'])('rejects %s output safely', async kind => {
    const output = kind === 'oversize' ? new Response('x', { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(101 * 1024 * 1024) } })
      : kind === 'redirect' ? new Response(null, { status: 302, headers: { 'Content-Type': 'video/mp4', Location: 'https://evil.test' } })
      : new Response('not mp4', { headers: { 'Content-Type': kind === 'wrong-mime' ? 'text/html' : 'video/mp4' } });
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ video: { url: 'https://v3b.fal.media/files/b/test.mp4', content_type: 'video/mp4' } })).mockResolvedValueOnce(Response.json({ token: 'temporary' })).mockResolvedValueOnce(output);
    await expect(new FalWanProvider('dummy', request).download(validateWanReceipt(queued, 'MOVE'), 'MOVE')).rejects.toThrow();
  });
});
