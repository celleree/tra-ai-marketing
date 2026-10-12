/** Server-only transport. Callers own authenticated media authority, permissions, quote and durable job storage. */
export const HIGGSFIELD_MOTION_MODEL = 'kling-video/motion-control/std';
const origin = 'https://api.higgsfield.ai';
type JobStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw' | 'canceled';
export type HiggsfieldJob = { requestId: string; status: JobStatus; statusUrl: string | null; videoUrl: string | null };
export type MotionControlInput = {
  imageUrl: string; motionVideoUrl: string; prompt: string;
  characterOrientation: 'image' | 'video'; keepOriginalSound: boolean;
};
export type MotionControlAdmission = {
  authorizationReference: string; permissionReference: string; quoteReference: string;
  quotedCostUsd: number; maxCostUsd: number; idempotencyKey: string;
};
type Transport = { keyId: string; keySecret: string; fetch?: typeof fetch; signal?: AbortSignal };
export class HiggsfieldError extends Error {
  constructor(public readonly code: 'invalid_input' | 'missing_credentials' | 'http_error' | 'ambiguous_submission' | 'transport_error' | 'invalid_response', public readonly httpStatus?: number) {
    super(`Higgsfield ${code}.`); this.name = 'HiggsfieldError';
  }
}
const text = (value: string, max: number) => typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
const https = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 12000) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
};
const requestId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const statusUrl = (value: unknown, id: string): value is string => {
  if (!https(value)) return false;
  const url = new URL(value);
  return url.origin === origin && url.pathname === `/requests/${id}/status` && !url.search && !url.hash;
};
function parseJob(value: unknown, expectedId?: string): HiggsfieldJob {
  const v = value as Record<string, unknown> | null;
  if (!v || !requestId(v.request_id) || (expectedId && v.request_id !== expectedId)
    || !['queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled'].includes(String(v.status))
    || typeof v.status !== 'string') throw new HiggsfieldError('invalid_response');
  const video = v.video as { url?: unknown } | null;
  if (v.status === 'completed' && !https(video?.url)) throw new HiggsfieldError('invalid_response');
  if ((v.status === 'queued' || v.status === 'in_progress') && !statusUrl(v.status_url, v.request_id))
    throw new HiggsfieldError('invalid_response');
  return { requestId: v.request_id, status: v.status as JobStatus,
    statusUrl: statusUrl(v.status_url, v.request_id) ? v.status_url : null,
    videoUrl: v.status === 'completed' ? video!.url as string : null };
}
async function call(url: string, options: Transport, method: 'POST' | 'GET', body?: string, idempotencyKey?: string): Promise<unknown> {
  if (typeof window !== 'undefined' || !text(options.keyId, 1000) || !text(options.keySecret, 1000)
    || /[\r\n:]/.test(options.keyId) || /[\r\n:]/.test(options.keySecret)) throw new HiggsfieldError('missing_credentials');
  if (options.signal?.aborted) throw new HiggsfieldError('transport_error');
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { method, body, redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      headers: { Authorization: `Key ${options.keyId}:${options.keySecret}`, 'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) } });
  } catch { throw new HiggsfieldError(method === 'POST' ? 'ambiguous_submission' : 'transport_error'); }
  // Never forward arbitrary provider error bodies, keys or signed input URLs.
  if (!response.ok) throw new HiggsfieldError(method === 'POST' && response.status >= 500 ? 'ambiguous_submission' : 'http_error', response.status);
  try { return await response.json(); } catch { throw new HiggsfieldError('invalid_response'); }
}

/** One submission, no retry/fallback. Admission is caller-approved evidence, not a provider-enforced dollar cap. */
export async function submitMotionControl(input: MotionControlInput, admission: MotionControlAdmission, options: Transport): Promise<HiggsfieldJob> {
  if (!https(input.imageUrl) || !https(input.motionVideoUrl) || typeof input.prompt !== 'string' || input.prompt.length > 12000
    || !['image', 'video'].includes(input.characterOrientation) || typeof input.keepOriginalSound !== 'boolean'
    || ![admission.authorizationReference, admission.permissionReference, admission.quoteReference].every(value => text(value, 2000))
    || typeof admission.idempotencyKey !== 'string' || !/^[!-~]{1,255}$/.test(admission.idempotencyKey)
    || !Number.isFinite(admission.quotedCostUsd) || admission.quotedCostUsd <= 0
    || !Number.isFinite(admission.maxCostUsd) || admission.maxCostUsd <= 0 || admission.quotedCostUsd > admission.maxCostUsd)
    throw new HiggsfieldError('invalid_input');
  return parseJob(await call(`${origin}/${HIGGSFIELD_MOTION_MODEL}`, options, 'POST', JSON.stringify({
    image_url: input.imageUrl, video_url: input.motionVideoUrl, prompt: input.prompt,
    keep_original_sound: input.keepOriginalSound ? 'yes' : 'no', character_orientation: input.characterOrientation,
  }), admission.idempotencyKey));
}

/** Poll only the supplied accepted job; never resubmit generation after an interruption. */
export async function readMotionControlJob(job: HiggsfieldJob, options: Transport): Promise<HiggsfieldJob> {
  if (!requestId(job.requestId) || !statusUrl(job.statusUrl, job.requestId)) throw new HiggsfieldError('invalid_input');
  return parseJob(await call(job.statusUrl, options, 'GET'), job.requestId);
}
