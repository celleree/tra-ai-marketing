import { isSupportedMp4Container } from '@/lib/media/storage';
import { WanError, type WanMode, type WanReceipt, type WanResolution } from './types';

const QUEUE = 'https://queue.fal.run';
export const wanModel = (mode: WanMode) => `fal-ai/wan/v2.2-14b/animate/${mode === 'MOVE' ? 'move' : 'replace'}`;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id);
export const validateWanReceipt = (value: unknown, mode: WanMode): WanReceipt => {
  const v = value as Record<string, unknown> | null;
  if (!v || !validId(v.request_id)) throw new WanError('Invalid provider receipt.', 502);
  const id = v.request_id;
  const validate = (value: unknown, status: boolean) => {
    if (typeof value !== 'string') throw new WanError('Invalid provider receipt.', 502);
    let url: URL; try { url = new URL(value); } catch { throw new WanError('Invalid provider receipt.', 502); }
    // Official JS SDK uses owner/alias (fal-ai/wan), removing the model subpath.
    const bases = [`/fal-ai/wan/requests/${id}`, `/${wanModel(mode)}/requests/${id}`];
    const paths = bases.flatMap(base => status ? [`${base}/status`] : [base, `${base}/response`]);
    if (url.origin !== QUEUE || url.username || url.password || url.search || url.hash || !paths.includes(url.pathname)) throw new WanError('Invalid provider receipt.', 502);
    return url.href;
  };
  return { requestId: id, statusUrl: validate(v.status_url, true), responseUrl: validate(v.response_url, false) };
};
export interface WanProvider {
  submit(mode: WanMode, resolution: WanResolution, imageUrl: string, videoUrl: string): Promise<WanReceipt>;
  poll(receipt: WanReceipt, mode: WanMode): Promise<{ state: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' }>;
  download(receipt: WanReceipt, mode: WanMode): Promise<Buffer>;
}
async function boundedBytes(response: Response, limit: number) {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > limit) throw new WanError('Provider response unavailable or too large.', 502);
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) throw new WanError('Provider response too large.', 502);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}
export class FalWanProvider implements WanProvider {
  constructor(private readonly key: string, private readonly request: typeof fetch = fetch) {
    if (typeof window !== 'undefined' || !key.trim() || /[\r\n]/.test(key)) throw new WanError('Provider unavailable.', 503);
  }
  private async json(url: string, method = 'GET', body?: unknown, extra?: Record<string, string>) {
    const response = await this.request(url, { method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Key ${this.key}`, 'Content-Type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return JSON.parse((await boundedBytes(response, 1024 * 1024)).toString()) as Record<string, unknown>;
  }
  async submit(mode: WanMode, resolution: WanResolution, imageUrl: string, videoUrl: string) {
    const value = await this.json(`${QUEUE}/${wanModel(mode)}`, 'POST', {
      image_url: imageUrl, video_url: videoUrl, resolution,
      enable_safety_checker: true, enable_output_safety_checker: true,
    }, { 'X-Fal-No-Retry': '1', 'X-Fal-Request-Start-Timeout': '60', 'X-Fal-Store-IO': '0',
      'X-Fal-Object-Lifecycle-Preference': JSON.stringify({ expiration_duration_seconds: 3600, initial_acl: { default: 'forbid', rules: [] } }) });
    return validateWanReceipt(value, mode);
  }
  private checked(receipt: WanReceipt, mode: WanMode) {
    return validateWanReceipt({ request_id: receipt.requestId, status_url: receipt.statusUrl, response_url: receipt.responseUrl }, mode);
  }
  async poll(receipt: WanReceipt, mode: WanMode) {
    const r = this.checked(receipt, mode); const value = await this.json(r.statusUrl);
    if (value.request_id !== r.requestId || !['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'].includes(String(value.status))) throw new WanError('Provider status unavailable.', 502);
    if (value.status === 'COMPLETED' && (value.error || value.error_type)) return { state: 'FAILED' as const };
    return { state: value.status as 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' };
  }
  async download(receipt: WanReceipt, mode: WanMode) {
    const value = await this.json(this.checked(receipt, mode).responseUrl);
    const video = value.video as { url?: unknown; content_type?: unknown } | undefined;
    if (typeof video?.url !== 'string' || video.content_type !== 'video/mp4') throw new WanError('Provider MP4 output unavailable.', 502);
    let url: URL; try { url = new URL(video.url); } catch { throw new WanError('Invalid provider output.', 502); }
    if (url.protocol !== 'https:' || url.hostname !== 'v3b.fal.media' || url.port || url.username || url.password || url.hash
      || !/^\/files\/[a-zA-Z0-9_./-]+\.mp4$/.test(url.pathname) || url.pathname.includes('..')) throw new WanError('Invalid private provider output.', 502);
    const auth = await this.json('https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3', 'POST', { expiration_seconds: 300 });
    if (typeof auth.token !== 'string' || !auth.token || /[\r\n]/.test(auth.token)) throw new WanError('Private output authorization unavailable.', 502);
    const response = await this.request(url.href, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${auth.token}` } });
    if (response.headers.get('content-type')?.split(';')[0].trim() !== 'video/mp4') throw new WanError('Provider output is not MP4.', 502);
    const bytes = await boundedBytes(response, 100 * 1024 * 1024);
    if (!isSupportedMp4Container(bytes)) throw new WanError('Provider output is not a valid MP4 container.', 502);
    return bytes;
  }
}
