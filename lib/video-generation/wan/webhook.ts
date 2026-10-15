import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { WanError } from './errors';

const JWKS = 'https://rest.fal.ai/.well-known/jwks.json';
let cache: { expires: number; keys: string[] } | undefined;
export async function readWebhookBytes(message: Request | Response, limit = 128 * 1024): Promise<Buffer> {
  if (!message.body || Number(message.headers.get('content-length') || 0) > limit) throw new WanError('Invalid callback body.', 413);
  const reader = message.body.getReader(), chunks: Buffer[] = []; let size = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new WanError('Invalid callback body.', 413); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
export function wanWebhookSettings() {
  const origin = process.env.WAN_WEBHOOK_ORIGIN ?? '', userId = process.env.FAL_WEBHOOK_USER_ID ?? '';
  let url: URL; try { url = new URL(origin); } catch { throw new WanError('Configure the public Wan completion callback before paid generation.', 503); }
  const environment = process.env.VERCEL_ENV;
  const known = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL,
    ...(environment === 'production' ? [process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.CREATIVE_PUBLIC_BASE_URL?.replace(/^https:\/\//, '')] : [])]
    .filter(Boolean).map(host => `https://${host}`);
  if (!process.env.VERCEL_URL || !['preview', 'production'].includes(environment ?? '') || url.protocol !== 'https:' || url.origin !== origin || !known.includes(origin)
    || url.username || url.password || !/^[\x21-\x7e]{1,200}$/.test(userId)) throw new WanError('Wan callback must match this deployment and its Fal account.', 503);
  return { origin, userId };
}
/** Anonymous read-only self probe fails closed on deployment protection/redirects or an old alias. */
export async function prepareWanWebhook(owner: string, id: string, request: typeof fetch = fetch) {
  const settings = wanWebhookSettings(), url = new URL('/api/ai-videos/webhook', settings.origin), challenge = randomUUID();
  url.searchParams.set('challenge', challenge);
  try {
    const response = await request(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    const probe = JSON.parse((await readWebhookBytes(response, 4096)).toString());
    if (probe.version !== 1 || probe.challenge !== challenge || probe.deployment !== process.env.VERCEL_URL) throw new Error();
  } catch { throw new WanError('The completion callback is not publicly reachable on this deployment. Ask the administrator to configure it before paid generation.', 503); }
  url.search = ''; url.searchParams.set('operator', createHash('sha256').update(owner).digest('hex')); url.searchParams.set('job', id);
  return { url: url.href, userId: settings.userId };
}
/** Official raw-body ED25519 signature contract; the configured Fal account is checked against the frozen job later. */
export async function verifyWanWebhook(headers: Headers, bytes: Buffer, dependencies: { request?: typeof fetch; now?: number; keys?: string[] } = {}) {
  const requestId = headers.get('x-fal-webhook-request-id') ?? '', userId = headers.get('x-fal-webhook-user-id') ?? '';
  const timestamp = headers.get('x-fal-webhook-timestamp') ?? '', signature = headers.get('x-fal-webhook-signature') ?? '';
  const now = dependencies.now ?? Date.now();
  if (!/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(requestId) || !/^[\x21-\x7e]{1,200}$/.test(userId)
    || !/^\d{1,12}$/.test(timestamp) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300 || !/^[a-f\d]{128}$/i.test(signature)) throw new WanError('Invalid completion signature.', 401);
  let keys = dependencies.keys;
  if (!keys) {
    if (!cache || cache.expires <= now) {
      try {
        const response = await (dependencies.request ?? fetch)(JWKS, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error();
        const value = JSON.parse((await readWebhookBytes(response, 65536)).toString());
        if (!Array.isArray(value.keys) || value.keys.length > 32) throw new Error();
        const found = value.keys.map((key: { x?: unknown }) => key.x).filter((x: unknown): x is string => typeof x === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(x));
        if (!found.length) throw new Error(); cache = { keys: found, expires: now + 3600000 };
      } catch { throw new WanError('Completion verification is temporarily unavailable.', 503); }
    }
    keys = cache.keys;
  }
  const message = Buffer.from([requestId, userId, timestamp, createHash('sha256').update(bytes).digest('hex')].join('\n'));
  if (!keys.some(x => { try { return verify(null, message, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }), Buffer.from(signature, 'hex')); } catch { return false; } })) { if (!dependencies.keys) cache = undefined; throw new WanError('Invalid completion signature.', 401); }
  return { requestId, userId };
}
