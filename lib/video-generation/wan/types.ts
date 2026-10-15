import { WanError } from './errors';
import { wanWebhookSettings } from './webhook';
export type WanMode = 'MOVE' | 'REPLACE';
export type WanResolution = '480p' | '580p' | '720p';
export type WanState = 'QUOTED' | 'SUBMITTING' | 'UNKNOWN' | 'IN_QUEUE' | 'IN_PROGRESS' | 'RECOVERY' | 'FAILED' | 'SUCCEEDED';
export interface WanQuote {
  id: string; frames: number; durationMs: number; estimatedCents: number;
  pricingVersion: 'fal-wan-2026-10-15'; expiresAt: number;
}
export interface WanReceipt { requestId: string; statusUrl: string; responseUrl: string }
export interface WanJob {
  id: string; owner: string; createdAt: number; updatedAt: number; state: WanState;
  profile: { name: string; notes: string }; imageId: string; videoId: string;
  imageHash: string; videoHash: string; mode: WanMode; resolution: WanResolution;
  quote: WanQuote; webhookUserId?: string; launchedAt?: number; consent?: { quoteId: string; acceptedAt: number; rights: true; providerTransfer: true; estimatedCost: true }; receipt?: WanReceipt; message?: string;
}
export type WanSummary = Pick<WanJob, 'id' | 'createdAt' | 'updatedAt' | 'state' | 'profile' | 'mode' | 'resolution' | 'quote' | 'message'> & { outputUrl?: string };
export const summarizeWanJob = (job: WanJob): WanSummary => ({
  id: job.id, createdAt: job.createdAt, updatedAt: job.updatedAt, state: job.state,
  profile: job.profile, mode: job.mode, resolution: job.resolution, quote: job.quote,
  message: job.message, ...(job.state === 'SUCCEEDED' ? { outputUrl: `/api/ai-videos/${job.id}/output` } : {}),
});
export { WanError } from './errors';
export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_FRAMES = 1800;
export const MAX_DURATION_MS = 30_000;
export const estimateWanCents = (frames: number, resolution: WanResolution) => {
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > MAX_FRAMES) throw new WanError('Source must contain 1–1800 decoded frames.');
  return Math.ceil(frames / 16) * ({ '480p': 4, '580p': 6, '720p': 8 }[resolution]);
};
export const wanAccessEnabled = () => process.env.WAN_ACCESS_ENABLED === 'true';
export const wanPaidEnabled = () => {
  try { wanWebhookSettings(); return wanAccessEnabled() && process.env.WAN_PAID_ENABLED === 'true' && Boolean(process.env.FAL_KEY?.trim()); } catch { return false; }
};
export const maxEstimatedCents = () => {
  const value = Number(process.env.WAN_MAX_ESTIMATED_USD ?? '5');
  if (!Number.isFinite(value) || value <= 0 || value > 5) throw new WanError('Wan estimate limit must be greater than zero and at most $5.', 503);
  return Math.floor(value * 100);
};
