import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { PREVIEW_TEST_APPROVAL, isApprovedPreviewPortfolio } from '@/lib/creatives/preview-test-approval';
import { PreviewAcceptanceError } from '@/lib/creatives/preview-acceptance';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import type { CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import type { ProviderAttemptMetadata } from '@/lib/ai/provider-usage';
export { PREVIEW_ADVANCE_HEADER } from '@/lib/creatives/preview-test-binding';

const prefix = 'preview-test-calls/v1/' + PREVIEW_TEST_APPROVAL.id + '/';
const fenceKey = prefix + 'advance-fence.json', stopKey = prefix + 'stopped.json';
export const isApprovedPreviewAdvanceId = (id: string) => process.env.VERCEL_ENV === 'preview'
  && process.env.TRA_IMAGE_PURPOSE === 'staging-smoke' && id === PREVIEW_TEST_APPROVAL.portfolioId;
const message = 'This approved Preview test is stopped after an interrupted or failed request. Further work is not authorized.';
const scopes = new AsyncLocalStorage<{ nonce: string; storage: VideoIntelligenceStorage }>();
const readFence = async (storage: VideoIntelligenceStorage) => {
  const row = await storage.read(fenceKey);
  if (!row) return null;
  const value = JSON.parse(row.bytes.toString());
  if (value?.version !== 1 || !/^[a-f0-9]{32}$/.test(value.nonce)) throw new Error(message);
  return { ...row, nonce: value.nonce as string };
};

/** Preserve another worker's lease and saved pixels; the independent stop is checked before purchase. */
export async function stopApprovedPreviewAdvance(id: string, storage = getVideoIntelligenceStorage()) {
  if (!isApprovedPreviewAdvanceId(id)) return;
  const results = await Promise.allSettled([
    storage.write(stopKey, Buffer.from(JSON.stringify({ version: 1, message })), null),
    updateCreativePortfolio(id, current => isApprovedPreviewPortfolio(current)
      ? { ...current, previewAcceptanceError: current.previewAcceptanceError ?? message } : current, storage),
  ]);
  const confirmed = results[0].status === 'fulfilled' || (results[1].status === 'fulfilled' && results[1].value.previewAcceptanceError);
  if (!confirmed) throw new PreviewAcceptanceError('Preview stop persistence could not be confirmed. No continuation is authorized.');
}

/** A nonce is never unlocked in storage: only a successfully delivered response can authorize the next CAS. */
export async function withApprovedPreviewAdvance<T>(id: string, previous: string | undefined,
  work: (nonce: string) => Promise<T>, storage = getVideoIntelligenceStorage()): Promise<T> {
  try {
    if (await storage.read(stopKey)) throw new Error(message);
    const current = await readFence(storage);
    if (current ? current.nonce !== previous : previous !== undefined) throw new Error(message);
    const nonce = randomUUID().replaceAll('-', '');
    if (!await storage.write(fenceKey, Buffer.from(JSON.stringify({ version: 1, nonce })), current?.etag ?? null)) throw new Error(message);
    return await scopes.run({ nonce, storage }, () => work(nonce));
  } catch (error) {
    await stopApprovedPreviewAdvance(id, storage);
    throw error;
  }
}

/** GET only reports continuation authority; it never issues or recovers a nonce. */
export async function previewAdvanceReadback(job: CreativePortfolioJob, previous?: string, suppliedStorage?: VideoIntelligenceStorage) {
  if (!isApprovedPreviewPortfolio(job)) return job;
  const storage = suppliedStorage ?? getVideoIntelligenceStorage();
  const stopped = await storage.read(stopKey);
  const fence = await readFence(storage);
  return stopped || (fence ? fence.nonce !== previous : previous !== undefined)
    ? { ...job, previewAcceptanceError: job.previewAcceptanceError ?? message } : job;
}

export async function assertPreviewAdvanceDispatch(meta: ProviderAttemptMetadata) {
  const scope = scopes.getStore();
  if (!scope || !isApprovedPreviewAdvanceId(meta.portfolioId ?? '')) return;
  if (await scope.storage.read(stopKey) || (await readFence(scope.storage))?.nonce !== scope.nonce
    || (await readCreativePortfolio(meta.portfolioId!, scope.storage))?.previewAcceptanceError) throw new Error(message);
}

export async function assertPreviewAdvanceResponse(nonce: string) {
  const scope = scopes.getStore();
  if (!scope || scope.nonce !== nonce || await scope.storage.read(stopKey)
    || (await readFence(scope.storage))?.nonce !== nonce
    || (await readCreativePortfolio(PREVIEW_TEST_APPROVAL.portfolioId, scope.storage))?.previewAcceptanceError) throw new Error(message);
}
