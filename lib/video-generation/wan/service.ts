import { prepareWanWebhook } from './webhook';
import { createHash, randomUUID } from 'node:crypto';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { FalWanProvider, type WanProvider } from './fal';
import { loadWanSources, probeWanVideo, signWanSource } from './sources';
import { estimateWanCents, maxEstimatedCents, summarizeWanJob, wanAccessEnabled, wanPaidEnabled, WanError, type WanJob, type WanMode, type WanResolution } from './types';

type Ledger = { jobs: WanJob[] };
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const safeId = (id: string) => /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id);
export interface WanDependencies {
  storage: VideoIntelligenceStorage; provider: WanProvider; now: () => number;
  sources: typeof loadWanSources; probe: typeof probeWanVideo; sign: typeof signWanSource;
  webhook: typeof prepareWanWebhook;
  access: () => boolean; paid: () => boolean; maxCents: () => number;
}
export class WanService {
  constructor(private readonly deps: WanDependencies) {}
  private ledgerKey(owner: string) { return `wan-generation/v1/operators/${hash(owner)}/ledger.json`; }
  private outputKey(owner: string, id: string) {
    if (!safeId(id)) throw new WanError('Job not found.', 404);
    return `wan-generation/v1/operators/${hash(owner)}/jobs/${id}/output.mp4`;
  }
  private async ledger(owner: string) {
    const value = await this.deps.storage.read(this.ledgerKey(owner));
    return { data: value ? JSON.parse(value.bytes.toString()) as Ledger : { jobs: [] }, etag: value?.etag ?? null };
  }
  private async mutate<T>(owner: string, operation: (ledger: Ledger) => T): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.ledger(owner); const result = operation(current.data);
      if (await this.deps.storage.write(this.ledgerKey(owner), Buffer.from(JSON.stringify(current.data)), current.etag)) return result;
    }
    throw new WanError('Jobs changed concurrently. Refresh and retry.', 409);
  }
  private requireAccess() { if (!this.deps.access()) throw new WanError('AI Videos access is disabled. Activation requires administrator approval.', 503); }
  private requirePaid() { this.requireAccess(); if (!this.deps.paid()) throw new WanError('Paid Wan generation is disabled. No provider request was made.', 503); }
  async list(owner: string) {
    this.requireAccess();
    return (await this.ledger(owner)).data.jobs.filter(job => job.owner === owner).map(summarizeWanJob).reverse();
  }
  async get(owner: string, id: string) {
    if (!safeId(id)) throw new WanError('Job not found.', 404);
    const job = (await this.ledger(owner)).data.jobs.find(job => job.id === id && job.owner === owner);
    if (!job) throw new WanError('Job not found.', 404);
    return job;
  }
  async quote(owner: string, body: Record<string, unknown>) {
    this.requireAccess();
    const profile = body.profile as { name?: unknown; notes?: unknown } | undefined;
    if (typeof profile?.name !== 'string' || !profile.name.trim() || profile.name.length > 100 || typeof profile.notes !== 'string' || profile.notes.length > 2000
      || !['MOVE', 'REPLACE'].includes(String(body.mode)) || !['480p', '580p', '720p'].includes(String(body.resolution))
      || typeof body.imageId !== 'string' || typeof body.videoId !== 'string') throw new WanError('Complete the character profile, image, source MP4, mode and resolution.');
    const sources = await this.deps.sources(body.imageId, body.videoId);
    const probe = await this.deps.probe(sources.video.buffer);
    const mode = body.mode as WanMode; const resolution = body.resolution as WanResolution;
    const estimatedCents = estimateWanCents(probe.frames, resolution);
    if (estimatedCents > this.deps.maxCents()) throw new WanError('Estimated cost exceeds the configured limit. Choose a shorter video or lower resolution.');
    const now = this.deps.now();
    const job: WanJob = { id: randomUUID(), owner, createdAt: now, updatedAt: now, state: 'QUOTED',
      profile: { name: profile.name.trim(), notes: profile.notes.trim() }, mode, resolution,
      imageId: body.imageId, videoId: body.videoId, imageHash: hash(sources.image.buffer), videoHash: hash(sources.video.buffer),
      quote: { id: randomUUID(), ...probe, estimatedCents, pricingVersion: 'fal-wan-2026-10-15', expiresAt: now + 10 * 60_000 } };
    await this.mutate(owner, ledger => {
      if (ledger.jobs.length >= 100) throw new WanError('Job history is full. Ask an administrator to archive completed jobs.', 409);
      ledger.jobs.push(job);
    });
    return summarizeWanJob(job);
  }
  async launch(owner: string, id: string, body: Record<string, unknown>) {
    this.requirePaid(); const existing = await this.get(owner, id);
    if (existing.state !== 'QUOTED') return summarizeWanJob(existing);
    if (body.quoteId !== existing.quote.id || body.rightsConfirmed !== true || body.providerTransferConfirmed !== true || body.estimatedCostConfirmed !== true) throw new WanError('Confirm this quote, source and likeness rights, provider transfer and estimated cost.');
    if (existing.quote.expiresAt <= this.deps.now() || existing.quote.estimatedCents > this.deps.maxCents()) throw new WanError('Quote expired or exceeds the current limit. Prepare a new quote.');
    const webhook = await this.deps.webhook(owner, id);
    const sources = await this.deps.sources(existing.imageId, existing.videoId);
    if (hash(sources.image.buffer) !== existing.imageHash || hash(sources.video.buffer) !== existing.videoHash) throw new WanError('Source files changed. Prepare a new quote.');
    const [imageUrl, videoUrl] = await Promise.all([this.deps.sign(sources.image.fileName), this.deps.sign(sources.video.fileName)]);
    const claimed = await this.mutate(owner, ledger => {
      const job = ledger.jobs.find(job => job.id === id && job.owner === owner)!;
      if (job.state !== 'QUOTED') return false;
      const now = this.deps.now();
      if (job.quote.expiresAt <= now) throw new WanError('Quote expired. Prepare a new quote.');
      const launches = ledger.jobs.filter(job => job.launchedAt !== undefined && job.launchedAt > now - 3_600_000).length;
      if (launches >= 3) throw new WanError('Wan launch limit reached (3 per hour). Wait before launching another job.', 429);
      job.webhookUserId = webhook.userId; job.state = 'SUBMITTING'; job.updatedAt = Math.max(now, job.updatedAt + 1); job.launchedAt = now;
      job.consent = { quoteId: job.quote.id, acceptedAt: now, rights: true, providerTransfer: true, estimatedCost: true };
      return true;
    });
    if (!claimed) return summarizeWanJob(await this.get(owner, id));
    // Exactly one attempt after the durable claim. Never retry this POST, including HTTP errors.
    try {
      const receipt = await this.deps.provider.submit(existing.mode, existing.resolution, imageUrl, videoUrl, webhook.url);
      await this.mutate(owner, ledger => {
        const job = ledger.jobs.find(job => job.id === id)!;
        if (job.receipt && job.receipt.requestId !== receipt.requestId) throw new WanError('Provider receipt requires reconciliation.', 409);
        job.receipt = receipt; if (['SUBMITTING', 'UNKNOWN'].includes(job.state)) { job.state = 'IN_QUEUE'; job.message = undefined; }
        job.updatedAt = Math.max(this.deps.now(), job.updatedAt + 1);
      });
    } catch {
      await this.mutate(owner, ledger => {
        const job = ledger.jobs.find(job => job.id === id)!;
        if (!job.receipt) { job.state = 'UNKNOWN'; job.updatedAt = Math.max(this.deps.now(), job.updatedAt + 1); job.message = 'Submission outcome is unknown. Do not launch a replacement until an administrator reconciles provider billing and request history.'; }
      });
    }
    return summarizeWanJob(await this.get(owner, id));
  }
  async refresh(owner: string, id: string) { this.requireAccess(); return this.recover(owner, id); }
  private async recover(owner: string, id: string) {
    const before = await this.get(owner, id);
    if (before.state === 'SUBMITTING' && before.updatedAt + 90_000 < this.deps.now()) {
      await this.mutate(owner, ledger => {
        const job = ledger.jobs.find(job => job.id === id)!;
        if (job.state === 'SUBMITTING' && !job.receipt) { job.state = 'UNKNOWN'; job.updatedAt = Math.max(this.deps.now(), job.updatedAt + 1); job.message = 'Submission interrupted. An administrator must reconcile provider history before any replacement purchase.'; }
      });
      return summarizeWanJob(await this.get(owner, id));
    }
    if (!before.receipt || ['SUCCEEDED', 'FAILED'].includes(before.state)) return summarizeWanJob(before);
    // Accepted jobs can be recovered even when paid launches are switched off.
    let state: WanJob['state']; let message: string | undefined;
    try {
      const saved = await this.deps.storage.read(this.outputKey(owner, id));
      if (saved) state = 'SUCCEEDED';
      else {
        const status = await this.deps.provider.poll(before.receipt, before.mode);
        if (status.state === 'COMPLETED') {
          const bytes = await this.deps.provider.download(before.receipt, before.mode);
          const key = this.outputKey(owner, id);
          if (!await this.deps.storage.write(key, bytes, null) && !await this.deps.storage.read(key)) throw new Error('Output persistence failed.');
          state = 'SUCCEEDED';
        } else if (status.state === 'FAILED') { state = 'FAILED'; message = 'Provider reported generation failure. Review provider billing before purchasing another job.'; }
        else state = status.state;
      }
    } catch { state = 'RECOVERY'; message = 'Status or private output could not be retrieved. Resume this accepted request; permanently deleted provider outputs cannot be recovered from Fal. Check private app storage/backups before any new purchase. This does not purchase another generation.'; }
    await this.mutate(owner, ledger => {
      const job = ledger.jobs.find(job => job.id === id)!;
      if (job.state === 'SUCCEEDED' || job.state === 'FAILED') return;
      // A slower status request cannot regress a newer state.
      if (job.updatedAt !== before.updatedAt && state !== 'SUCCEEDED') return;
      job.state = state; job.message = message; job.updatedAt = Math.max(this.deps.now(), job.updatedAt + 1);
    });
    return summarizeWanJob(await this.get(owner, id));
  }
  /** Called only after the Fal signature is verified. Frozen billing account and receipt bind the notification to this paid job. */
  async completeWebhook(operatorHash: string, id: string, requestId: string, userId: string, status: 'OK' | 'ERROR') {
    if (!/^[a-f0-9]{64}$/.test(operatorHash) || !safeId(id) || !safeId(requestId)) throw new WanError('Completion job not found.', 404);
    const stored = await this.deps.storage.read(`wan-generation/v1/operators/${operatorHash}/ledger.json`);
    const job = stored ? (JSON.parse(stored.bytes.toString()) as Ledger).jobs.find(item => item.id === id) : undefined;
    if (!job || hash(job.owner) !== operatorHash || job.launchedAt === undefined || job.webhookUserId !== userId
      || !job.consent || (job.receipt && job.receipt.requestId !== requestId)) throw new WanError('Completion does not match an accepted job.', 403);
    if (['SUCCEEDED', 'FAILED'].includes(job.state)) return;
    await this.mutate(job.owner, ledger => {
      const current = ledger.jobs.find(item => item.id === id)!;
      if (['SUCCEEDED', 'FAILED'].includes(current.state)) return;
      if (current.receipt && current.receipt.requestId !== requestId) throw new WanError('Completion receipt changed.', 409);
      // Recovers the ordinary callback-before-submit-response race, including interrupted acknowledgment.
      current.receipt ??= { requestId, statusUrl: `https://queue.fal.run/fal-ai/wan/requests/${requestId}/status`, responseUrl: `https://queue.fal.run/fal-ai/wan/requests/${requestId}` };
      if (status === 'ERROR') { current.state = 'FAILED'; current.message = 'Provider reported generation failure. Review billing before purchasing another job.'; }
      else if (['SUBMITTING', 'UNKNOWN'].includes(current.state)) current.state = 'IN_QUEUE';
      current.updatedAt = Math.max(this.deps.now(), current.updatedAt + 1);
    });
    if (status === 'ERROR') return;
    const saved = await this.recover(job.owner, id);
    // Fal retries failed deliveries. Never acknowledge success before bytes are durable.
    if (!['SUCCEEDED', 'FAILED'].includes(saved.state)) throw new WanError('Private output capture is pending. Retry this completion notification.', 503);
  }
  async output(owner: string, id: string) {
    this.requireAccess(); const job = await this.get(owner, id);
    if (job.state !== 'SUCCEEDED') throw new WanError('Output is not ready.', 409);
    const output = await this.deps.storage.read(this.outputKey(owner, id));
    if (!output) throw new WanError('Saved output is unavailable. Ask an administrator to restore it.', 410);
    return output.bytes;
  }
}
export const getWanService = () => new WanService({ storage: getVideoIntelligenceStorage(),
  provider: { submit: (...args) => new FalWanProvider(process.env.FAL_KEY || '').submit(...args),
    poll: (...args) => new FalWanProvider(process.env.FAL_KEY || '').poll(...args),
    download: (...args) => new FalWanProvider(process.env.FAL_KEY || '').download(...args) },
  webhook: prepareWanWebhook, now: Date.now, sources: loadWanSources, probe: probeWanVideo, sign: signWanSource,
  access: wanAccessEnabled, paid: wanPaidEnabled, maxCents: maxEstimatedCents });
