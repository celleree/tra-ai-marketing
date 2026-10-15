import { AsyncLocalStorage } from 'node:async_hooks';
import type { CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import type { ProviderAttemptMetadata } from '@/lib/ai/provider-usage';
import { PREVIEW_TEST_APPROVAL } from '@/lib/creatives/preview-test-binding';

const normal = new AsyncLocalStorage<{ portfolioId: string } | undefined>();
export const isPreviewTestPortfolio = (job: CreativePortfolioJob | null) => Boolean(job && (
  job.id === PREVIEW_TEST_APPROVAL.portfolioId || job.id === PREVIEW_TEST_APPROVAL.previousPortfolioId
  || job.slots.some(slot => PREVIEW_TEST_APPROVAL.creativeIds.includes(slot.creativeId))));

/** Called by authenticated saved-portfolio execution, never selected by request flags or provider metadata. */
export const withNormalPreviewPortfolio = <T>(job: CreativePortfolioJob | null, operatorId: string, work: () => Promise<T>) =>
  normal.run(process.env.VERCEL_ENV === 'preview' && process.env.TRA_IMAGE_PURPOSE === 'staging-smoke'
    && operatorId.trim() && job && !isPreviewTestPortfolio(job) && !job.previewAcceptanceError
    ? { portfolioId: job.id } : undefined, work);

export const hasNormalPreviewPortfolio = () => Boolean(normal.getStore());
export const isNormalPreviewProvider = (meta: ProviderAttemptMetadata) => {
  const scope = normal.getStore();
  return Boolean(scope && meta.portfolioId === scope.portfolioId
    && meta.portfolioId !== PREVIEW_TEST_APPROVAL.portfolioId && meta.portfolioId !== PREVIEW_TEST_APPROVAL.previousPortfolioId
    && !PREVIEW_TEST_APPROVAL.creativeIds.includes(meta.creativeId ?? ''));
};
