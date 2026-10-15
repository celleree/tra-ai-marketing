import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('@/lib/video-generation/wan/service', () => ({ getWanService: () => ({ completeWebhook: mocks.complete }) }));
import { GET, POST } from '@/app/api/ai-videos/webhook/route';
const id = '12345678-1234-1234-1234-123456789abc', pair = generateKeyPairSync('ed25519');
const url = `https://app.example/api/ai-videos/webhook?operator=${'a'.repeat(64)}&job=${id}`;
function request(body: unknown = { request_id: id, status: 'OK' }) {
  const bytes = Buffer.from(JSON.stringify(body)), timestamp = String(Math.floor(Date.now() / 1000));
  const signed = Buffer.from([id, 'fal-account', timestamp, createHash('sha256').update(bytes).digest('hex')].join('\n'));
  return new Request(url, { method: 'POST', body: bytes, headers: { 'x-fal-webhook-request-id': id, 'x-fal-webhook-user-id': 'fal-account', 'x-fal-webhook-timestamp': timestamp, 'x-fal-webhook-signature': sign(null, signed, pair.privateKey).toString('hex') } });
}
beforeEach(() => { mocks.complete.mockReset().mockResolvedValue(undefined); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ keys: [{ x: pair.publicKey.export({ format: 'jwk' }).x }] }))); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('handles provider-authenticated completion with no operator session and acknowledges only after capture', async () => {
  const response = await POST(request()); expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(mocks.complete).toHaveBeenCalledWith('a'.repeat(64), id, id, 'fal-account', 'OK');
});
it('rejects unsigned, wrong-body binding and oversized callbacks before storage/provider work', async () => {
  expect((await POST(new Request(url, { method: 'POST', body: '{}' }))).status).toBe(401);
  expect((await POST(request({ request_id: 'other', status: 'OK' }))).status).toBe(400);
  expect((await POST(new Request(url, { method: 'POST', body: '{}', headers: { 'content-length': String(129 * 1024) } }))).status).toBe(413);
  expect(mocks.complete).not.toHaveBeenCalled();
});
it('returns retryable failure and redacts internal capture errors', async () => {
  mocks.complete.mockRejectedValue(new Error('secret signed-url')); const response = await POST(request()); expect(response.status).toBe(503); expect(await response.text()).not.toContain('secret');
});
it('exposes only a read-only deployment health marker for the anonymous prelaunch probe', async () => {
  vi.stubEnv('VERCEL_URL', 'app.example'); const response = await GET(new Request(url + '&challenge=' + id));
  expect(await response.json()).toEqual({ version: 1, challenge: id, deployment: 'app.example' }); expect(mocks.complete).not.toHaveBeenCalled();
});
