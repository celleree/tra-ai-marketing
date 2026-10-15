import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }));
vi.mock('undici', () => ({ Agent: class { close = mocks.close; }, fetch: mocks.fetch }));
import { downloadSelectedImage, isPublicMediaAddress } from '@/lib/discovery/media';
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
describe('selected media boundary with mock responses', () => {
  it('rejects nonpublic DNS destinations including IPv4-mapped IPv6', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '2001:db8::1']) expect(isPublicMediaAddress(address)).toBe(false);
    expect(isPublicMediaAddress('31.13.70.1')).toBe(true);
  });
  it('rejects arbitrary URLs before transport and rejects redirects to unsupported hosts', async () => {
    await expect(downloadSelectedImage('https://internal.example/private')).rejects.toThrow('Unsupported'); expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }));
    await expect(downloadSelectedImage('https://scontent.xx.fbcdn.net/image.jpg')).rejects.toThrow('Unsupported'); expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts supported image bytes with manual redirect policy and a timeout', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { 'content-type': 'image/png' } }));
    const file = await downloadSelectedImage('https://scontent.xx.fbcdn.net/image.png');
    expect(file.type).toBe('image/png'); expect(mocks.fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual' }); expect(mocks.close).toHaveBeenCalled();
  });
  it('rejects HTML, mismatched magic, declared oversize, and streamed oversize', async () => {
    const url = 'https://scontent.xx.fbcdn.net/image.jpg';
    mocks.fetch.mockResolvedValueOnce(new Response('html', { headers: { 'content-type': 'text/html' } })); await expect(downloadSelectedImage(url)).rejects.toThrow('unsupported');
    mocks.fetch.mockResolvedValueOnce(new Response('not image', { headers: { 'content-type': 'image/jpeg' } })); await expect(downloadSelectedImage(url)).rejects.toThrow('contents');
    mocks.fetch.mockResolvedValueOnce(new Response('x', { headers: { 'content-type': 'image/jpeg', 'content-length': '999999999' } })); await expect(downloadSelectedImage(url)).rejects.toThrow('large');
    vi.stubEnv('MAX_IMAGE_UPLOAD_MB', '1');
    mocks.fetch.mockResolvedValueOnce(new Response(new Uint8Array(11 * 1024 * 1024), { headers: { 'content-type': 'image/jpeg' } })); await expect(downloadSelectedImage(url)).rejects.toThrow('limit');
  });
});
