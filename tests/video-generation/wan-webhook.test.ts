import { afterEach, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { prepareWanWebhook, verifyWanWebhook } from '@/lib/video-generation/wan/webhook';
const id = '12345678-1234-1234-1234-123456789abc', now = 1800000000000;
function signed(time = now) {
  const pair = generateKeyPairSync('ed25519'), bytes = Buffer.from(JSON.stringify({ request_id: id, status: 'OK' })), timestamp = String(time / 1000);
  const body = Buffer.from([id, 'fal-account', timestamp, createHash('sha256').update(bytes).digest('hex')].join('\n'));
  const headers = new Headers({ 'x-fal-webhook-request-id': id, 'x-fal-webhook-user-id': 'fal-account', 'x-fal-webhook-timestamp': timestamp, 'x-fal-webhook-signature': sign(null, body, pair.privateKey).toString('hex') });
  return { bytes, headers, keys: [pair.publicKey.export({ format: 'jwk' }).x!] };
}
afterEach(() => vi.unstubAllEnvs());
it('verifies the documented raw-body ED25519 contract and rejects tampering/stale or missing headers', async () => {
  const f = signed(); expect(await verifyWanWebhook(f.headers, f.bytes, { now, keys: f.keys })).toEqual({ requestId: id, userId: 'fal-account' });
  await expect(verifyWanWebhook(f.headers, Buffer.from('{}'), { now, keys: f.keys })).rejects.toMatchObject({ status: 401 });
  await expect(verifyWanWebhook(f.headers, f.bytes, { now: now + 301000, keys: f.keys })).rejects.toMatchObject({ status: 401 });
  for (const name of [...f.headers.keys()]) { const headers = new Headers(f.headers); headers.delete(name); await expect(verifyWanWebhook(headers, f.bytes, { now, keys: f.keys })).rejects.toMatchObject({ status: 401 }); }
});
it('fetches only fixed public JWKS, caches keys, and fails closed on key-service errors', async () => {
  vi.resetModules(); const { verifyWanWebhook: verify } = await import('@/lib/video-generation/wan/webhook'); const f = signed();
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ keys: f.keys.map(x => ({ x })) }));
  await verify(f.headers, f.bytes, { now, request }); await verify(f.headers, f.bytes, { now: now + 1000, request }); expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe('https://rest.fal.ai/.well-known/jwks.json');
  const later = signed(now + 3601000); request.mockRejectedValueOnce(new Error('unavailable')); await expect(verify(later.headers, later.bytes, { now: now + 3601000, request })).rejects.toMatchObject({ status: 503 });
});
it('requires a deployment-matched publicly reachable callback before a paid attempt', async () => {
  vi.stubEnv('VERCEL_ENV', 'preview'); vi.stubEnv('VERCEL_URL', 'preview.example'); vi.stubEnv('WAN_WEBHOOK_ORIGIN', 'https://preview.example'); vi.stubEnv('FAL_WEBHOOK_USER_ID', 'fal-account');
  const request = vi.fn<typeof fetch>().mockImplementation(async url => Response.json({ version: 1, challenge: new URL(String(url)).searchParams.get('challenge'), deployment: 'preview.example' }));
  const prepared = await prepareWanWebhook('operator', id, request); expect(new URL(prepared.url).searchParams.get('job')).toBe(id); expect(prepared.userId).toBe('fal-account');
  expect(request.mock.calls[0][1]).not.toHaveProperty('headers');
  request.mockResolvedValueOnce(new Response('Vercel login', { status: 401 })); await expect(prepareWanWebhook('operator', id, request)).rejects.toMatchObject({ status: 503 });
  request.mockResolvedValueOnce(Response.json({ version: 1, deployment: 'older.example' })); await expect(prepareWanWebhook('operator', id, request)).rejects.toMatchObject({ status: 503 });
  vi.stubEnv('WAN_WEBHOOK_ORIGIN', 'https://production.example'); await expect(prepareWanWebhook('operator', id, request)).rejects.toMatchObject({ status: 503 });
});

it('refreshes cached public keys after a rotation signature miss on delivery retry', async () => {
  vi.resetModules(); const { verifyWanWebhook: verify } = await import('@/lib/video-generation/wan/webhook');
  const old = signed(), rotated = signed(), request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ keys: old.keys.map(x => ({ x })) })).mockResolvedValueOnce(Response.json({ keys: rotated.keys.map(x => ({ x })) }));
  await verify(old.headers, old.bytes, { now, request });
  await expect(verify(rotated.headers, rotated.bytes, { now, request })).rejects.toMatchObject({ status: 401 });
  await verify(rotated.headers, rotated.bytes, { now, request }); expect(request).toHaveBeenCalledTimes(2);
});
