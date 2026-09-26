import { AsyncLocalStorage } from 'node:async_hooks';
import { providerUsageEvent, type ProviderAttemptMetadata, type ProviderUsageContext } from '@/lib/ai/provider-usage';
import { imageProviderFailure } from '@/lib/creatives/image-provider-failure';

type Context = ProviderUsageContext & { operationType?: string };
const contexts = new AsyncLocalStorage<Context>();
export const providerUsageContext = () => contexts.getStore() ?? {};
export const withProviderUsageContext = <T>(context: Context, work: () => Promise<T>) =>
  contexts.run({ ...providerUsageContext(), ...context }, work);

/** Emit only the allowlisted envelope. Logging must never change paid-work control flow. */
export function emitProviderUsage(meta: ProviderAttemptMetadata, outcome: Parameters<typeof providerUsageEvent>[1]) {
  try { console.info(JSON.stringify(providerUsageEvent(meta, outcome))); } catch { /* telemetry unavailable */ }
}

/** A start and terminal event share one attempt ID; aggregate by ID, never by log line. */
export async function observeProviderAttempt(meta: ProviderAttemptMetadata, dispatch: () => Promise<Response>): Promise<Response> {
  emitProviderUsage(meta, { status: 'started' });
  let response: Response;
  try { response = await dispatch(); }
  catch (error) { emitProviderUsage(meta, { status: 'unknown' }); throw error; }
  let body: any;
  try { body = await response.clone().json(); } catch { /* missing usage stays unknown */ }
  const validOutput = meta.endpoint !== 'images' || (body?.data?.length === 1
    && typeof body.data[0]?.b64_json === 'string' && body.data[0].b64_json.length > 0);
  const failureStatus = !response.ok && meta.endpoint === 'images'
    ? (await imageProviderFailure(response)).outcome === 'UNKNOWN' ? 'unknown' : 'failed'
    : response.status >= 500 || response.status === 408 ? 'unknown' : 'failed';
  emitProviderUsage(meta, {
    status: response.ok ? body && validOutput ? 'succeeded' : 'unknown'
      : failureStatus,
    requestId: response.headers.get('x-request-id'), usage: body?.usage, serviceTier: body?.service_tier,
  });
  return response;
}
