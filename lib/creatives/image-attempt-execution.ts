import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { fingerprintImageRenderRequest } from '@/lib/creatives/image-render-identity';
import { imageRenderPurpose } from '@/lib/creatives/image-render-request';
import { reserveImageAttempt, settleImageAttempt, type ImageAttemptBudget } from '@/lib/creatives/image-attempt-store';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { CreativeImageProviderError, imageProviderFailure } from '@/lib/creatives/image-provider-failure';
import { emitProviderUsage, observeProviderAttempt, providerUsageContext } from '@/lib/ai/provider-telemetry';
import type { ProviderAttemptMetadata, ProviderUsageContext } from '@/lib/ai/provider-usage';

type Scope = ProviderUsageContext & { runId: string; operationId: string; budget: ImageAttemptBudget; storage?: VideoIntelligenceStorage };
const scopes = new AsyncLocalStorage<Scope>();
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const resultKey = (sha256: string) => `paid-image-results/v1/${sha256}.json`;

export function imageAttemptBudget(count: number): ImageAttemptBudget {
  const purpose = imageRenderPurpose();
  return { purpose, primaryLimit: purpose === 'diagnostic' ? 1 : count,
    fallbackLimit: purpose === 'production' ? count : 0 };
}

export function withImageAttemptScope<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
  return scopes.run(scope, work);
}

/** Saves purchased bytes before caller validation, compositing or final creative persistence. */
export async function executeImageAttempt(endpoint: string, request: RequestInit, dispatch: () => Promise<Response>): Promise<Response> {
  const scope = scopes.getStore();
  const fields = request.body instanceof FormData ? Object.fromEntries(request.body.entries()) : JSON.parse(String(request.body));
  const kind = fields.model === 'gpt-image-2.5-sunburst' ? 'primary' as const : 'fallback' as const;
  const fingerprint = await fingerprintImageRenderRequest(endpoint, request);
  const meta: ProviderAttemptMetadata = { ...providerUsageContext(), ...scope, stage: 'image', endpoint: 'images',
    attemptId: scope ? digest(Buffer.from(JSON.stringify([scope.runId, scope.operationId, kind]))) : randomUUID(),
    model: String(fields.model), purpose: imageRenderPurpose(), quality: String(fields.quality), dimensions: String(fields.size),
    n: Number(fields.n), renderFingerprint: fingerprint, retryIndex: kind === 'primary' ? 0 : 1 };
  const paidDispatch = () => observeProviderAttempt(meta, dispatch);
  if (!scope) return paidDispatch();
  const storage = scope.storage ?? getVideoIntelligenceStorage();
  const input = { ...scope, kind, fingerprint };
  const claim = await reserveImageAttempt(input, storage);
  if (claim.status === 'COMPLETE') {
    const saved = await storage.read(resultKey(claim.result.sha256));
    if (!saved || saved.bytes.length !== claim.result.byteLength || digest(saved.bytes) !== claim.result.sha256) {
      throw new Error('Purchased image result is unavailable; no replacement purchase is authorized.');
    }
    emitProviderUsage(meta, { status: 'reused' });
    return new Response(saved.bytes.toString(), { headers: { 'Content-Type': 'application/json' } });
  }
  if (claim.status === 'FAILED') throw new CreativeImageProviderError('Previously recorded image provider failure.',
    claim.retryable ? claim.httpStatus === 429 ? 'rate_limited' : 'provider_unavailable' : null, 'FAILED', claim.httpStatus);
  if (claim.status !== 'CLAIMED') throw new Error(`Image attempt is ${claim.status}; no repeat purchase is authorized.`);
  const owned = { ...input, token: claim.token };
  let response: Response;
  try { response = await paidDispatch(); }
  catch {
    await settleImageAttempt(owned, { status: 'UNKNOWN' }, storage);
    throw new Error('Image provider outcome is unknown; no repeat purchase is authorized.');
  }
  if (!response.ok) {
    const failure = await imageProviderFailure(response);
    await settleImageAttempt(owned, failure.outcome === 'UNKNOWN' ? { status: 'UNKNOWN' }
      : { status: 'FAILED', httpStatus: response.status, retryable: failure.fallbackReason !== null }, storage);
    throw failure;
  }
  try {
    const body = await response.clone().json();
    if (body.data?.length !== 1 || typeof body.data[0].b64_json !== 'string' || !body.data[0].b64_json) {
      throw new Error('Missing image result');
    }
    const bytes = Buffer.from(JSON.stringify({ data: [{ b64_json: body.data[0].b64_json }], usage: body.usage }));
    const result = { sha256: digest(bytes), byteLength: bytes.length };
    const path = resultKey(result.sha256);
    if (!await storage.write(path, bytes, null)) {
      const existing = await storage.read(path);
      if (!existing || !existing.bytes.equals(bytes)) throw new Error('Image result storage conflict');
    }
    await settleImageAttempt(owned, { status: 'COMPLETE', result }, storage);
  } catch {
    // A write may have succeeded before its acknowledgement was lost. Never repurchase.
    throw new Error('Image result could not be confirmed durable; no repeat purchase is authorized.');
  }
  return response;
}
