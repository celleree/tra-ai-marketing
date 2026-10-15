import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parsePortfolioVideoDependencies, type PortfolioVideoDependency } from '@/lib/creatives/portfolio-video-dependency';
import { getMediaStorage } from '@/lib/media/local-storage';
import { hydrateCreativeSourceSelections } from '@/lib/media/source-hydration';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { videoIntelligenceJobId } from '@/lib/video/intelligence-job';
import { readVideoIntelligenceJob } from '@/lib/video/intelligence-job-store';
import { loadVideoIntelligenceLibrary } from '@/lib/video/intelligence-finalization-runner';
import { assertDurableVideoIntelligenceAvailable } from '@/lib/video/preview-availability';
import { executeVideoIntelligenceStep, readVideoIntelligenceSource, resolveVideoIntelligenceJobLocator,
  type CompactVideoIntelligenceJobStatus, type VideoIntelligenceServiceDependencies } from '@/lib/video/intelligence-service';
import { reserveOperatorQuota } from '@/lib/quotas/operator-quota';
import { VideoRetryStateChangedError } from '@/lib/video/intelligence-job-store';

type Owner = {
  operatorId: string;
  assertLease: () => Promise<void>;
  checkpoint: (dependency: PortfolioVideoDependency) => Promise<void>;
  onProviderOperationStart: () => void;
};
type RetryState = Pick<CompactVideoIntelligenceJobStatus, 'jobId' | 'updatedAtMs' | 'retry'>;
export type PortfolioVideoRetryAuthorization = RetryState & { etag: string };
type Action = { action: 'STATUS' } | ({ action: 'ADVANCE' } & Owner)
  | ({ action: 'RETRY'; retryAuthorization: PortfolioVideoRetryAuthorization;
    consumeRetryAuthorization: (expected: PortfolioVideoRetryAuthorization) => Promise<void> } & Owner);

/**
 * Owner callbacks must use durable, lease-checked
 * transactions. RETRY authorization must be consumed once before returning from its callback.
 * Never call this adapter inside a portfolio CAS callback; child jobs own separate leases.
 */
export async function stepPortfolioVideoDependency(
  input: { mediaId: string; dependency?: PortfolioVideoDependency } & Action,
  dependencies: VideoIntelligenceServiceDependencies,
): Promise<{ dependency: PortfolioVideoDependency; status: CompactVideoIntelligenceJobStatus | null;
  retryAuthorization?: PortfolioVideoRetryAuthorization }> {
  assertDurableVideoIntelligenceAvailable();
  const saved = input.dependency && parsePortfolioVideoDependencies([input.dependency],
    [{ mediaId: input.mediaId, role: 'TRA_VIDEO' }])[0];
  const checkpoint = async (dependency: PortfolioVideoDependency) => {
    if (input.action !== 'STATUS') { await input.assertLease(); await input.checkpoint(dependency); }
    return dependency;
  };
  // Saved completion is authoritative even if current analyzer settings have changed.
  if (saved?.completed) {
    const library = await loadVideoIntelligenceLibrary(saved.identity, saved.completed.artifact, dependencies);
    if (!isDeepStrictEqual({ id: library.id, version: library.version }, saved.completed.library)) throw new Error('Video library identity changed.');
    return { dependency: saved, status: null };
  }
  const hydrate = dependencies.hydrateSource ?? (async (mediaId: string) =>
    (await hydrateCreativeSourceSelections(getMediaStorage(), [{ mediaId, role: 'TRA_VIDEO' }]))[0] as HydratedTraVideoSource);
  const service = { ...dependencies, hydrateSource: async (mediaId: string) => {
    const source = await hydrate(mediaId);
    // Also protect the service's second START hydration before it creates a job.
    if (saved && (source.media.id !== saved.identity.sourceVideoMediaId
      || createHash('sha256').update(source.stored.buffer).digest('hex') !== saved.identity.sourceVideoContentHash)) {
      throw new Error('Video dependency source changed. Start fresh preparation.');
    }
    return source;
  } };
  const current = await readVideoIntelligenceSource(input.mediaId, service);
  const identity = resolveVideoIntelligenceJobLocator(current.locator);
  if (saved && !isDeepStrictEqual(saved.identity, identity)) throw new Error('Video dependency analyzer identity changed.');
  let dependency = saved ?? { version: 1 as const, identity, jobId: videoIntelligenceJobId(identity) };
  const retryAuthorization = async (status: CompactVideoIntelligenceJobStatus) => {
    const observed = await readVideoIntelligenceJob(identity, dependencies);
    if (!observed || observed.job.updatedAtMs !== status.updatedAtMs
      || !isDeepStrictEqual(observed.job.retry, status.retry)) throw new VideoRetryStateChangedError();
    return { jobId: status.jobId, updatedAtMs: status.updatedAtMs, retry: status.retry, etag: observed.etag };
  };
  const complete = async () => {
    const stored = await readVideoIntelligenceJob(identity, dependencies);
    if (stored?.job.phase !== 'COMPLETE' || !stored.job.result) throw new Error('Completed video job is unavailable.');
    const library = await loadVideoIntelligenceLibrary(identity, stored.job.result, dependencies);
    dependency = { ...dependency, completed: { artifact: stored.job.result, library: { id: library.id, version: library.version } } };
    parsePortfolioVideoDependencies([dependency], [{ mediaId: input.mediaId, role: 'TRA_VIDEO' }]);
    return checkpoint(dependency);
  };
  if (current.status?.phase === 'COMPLETE') return { dependency: await complete(), status: current.status };
  // Discovery must be saved before any later child operation. STATUS never saves anything.
  if (!saved) return { dependency: await checkpoint(dependency), status: current.status };
  if (input.action === 'STATUS') return { dependency, status: current.status,
    ...(current.status?.phase === 'RETRY_REQUIRED' ? { retryAuthorization: await retryAuthorization(current.status) } : {}) };
  if (current.status?.busy || current.status?.phase === 'FAILED') return { dependency, status: current.status };
  if (current.status?.phase === 'RETRY_REQUIRED' && input.action !== 'RETRY') {
    return { dependency, status: current.status, retryAuthorization: await retryAuthorization(current.status) };
  }
  if (input.action === 'RETRY' && current.status?.phase !== 'RETRY_REQUIRED') throw new Error('Video dependency does not require Retry.');
  const action = current.status ? input.action : 'START';
  await input.assertLease();
  const now = dependencies.now ?? Date.now;
  if (!Number.isSafeInteger(dependencies.deadlineAtMs) || dependencies.deadlineAtMs - now() < 65_000) {
    throw new Error('Insufficient time to advance video dependency.');
  }
  const quota = await reserveOperatorQuota({ operatorId: input.operatorId,
    group: action === 'START' ? 'VIDEO_PREPARATION' : 'VIDEO_PROVIDER_WORK', units: 1 }, dependencies);
  if (!quota.allowed) throw new Error(`Video quota reached. Resume after ${quota.retryAfterSeconds} seconds.`);
  if (input.action === 'RETRY') {
    const observed = await readVideoIntelligenceJob(identity, dependencies);
    if (!observed || observed.job.phase !== 'RETRY_REQUIRED' || observed.etag !== input.retryAuthorization.etag
      || observed.job.id !== input.retryAuthorization.jobId
      || observed.job.updatedAtMs !== input.retryAuthorization.updatedAtMs
      || !isDeepStrictEqual(observed.job.retry, input.retryAuthorization.retry)
      || observed.job.updatedAtMs !== current.status!.updatedAtMs || !isDeepStrictEqual(observed.job.retry, current.status!.retry)) {
      throw new VideoRetryStateChangedError();
    }
    service.expectedRetryEtag = observed.etag;
    await input.consumeRetryAuthorization(input.retryAuthorization);
  }
  await input.assertLease();
  // Conservatively mark the child operation before entry; persistence failure never loops here.
  input.onProviderOperationStart();
  const status = await executeVideoIntelligenceStep(action === 'START'
    ? { action, mediaId: input.mediaId } : { action, locator: current.locator }, service);
  return { dependency: status.phase === 'COMPLETE' ? await complete() : await checkpoint(dependency), status,
    ...(status.phase === 'RETRY_REQUIRED' ? { retryAuthorization: await retryAuthorization(status) } : {}) };
}
