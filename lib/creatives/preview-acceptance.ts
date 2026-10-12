import type { ProviderAttemptMetadata } from '@/lib/ai/provider-usage';
import type { ValidGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import type { CreativePortfolioJob } from '@/lib/creatives/portfolio-job';

/** Existing server purpose scopes this restriction to Preview acceptance only. */
export const isPreviewAcceptance = () => process.env.VERCEL_ENV === 'preview'
  && process.env.TRA_IMAGE_PURPOSE === 'staging-smoke';

export class PreviewAcceptanceError extends Error {
  readonly status = 409;
}

export function assertPreviewAcceptanceRequest(request: ValidGenerateCreativeRequest, frozen = false) {
  if (!isPreviewAcceptance()) return;
  if (request.variationCount !== 2 || request.placement !== 'PORTRAIT_4_5' || !request.brandLogoMediaId
    || request.sourceAssets.filter(source => source.role === 'TRA_VIDEO').length !== 1
    || request.sourceAssets.filter(source => source.role === 'LAYOUT_REFERENCE').length !== 1
    || request.sourceAssets.some(source => !['TRA_VIDEO', 'LAYOUT_REFERENCE'].includes(source.role))
    || (frozen ? !request.reviewHandoff?.choices.frames?.length : !request.videoReview)) {
    throw new PreviewAcceptanceError('Preview acceptance requires exactly two 4:5 creatives, the original logo, one completed video, one supplied layout reference and a saved manually selected frame pool.');
  }
}

export function assertPreviewAcceptanceJob(job: CreativePortfolioJob) {
  if (!isPreviewAcceptance()) return;
  assertPreviewAcceptanceRequest(job.request, true);
  if (job.sourceCompositionVersion !== 2 || job.videoPreparationVersion !== 1
    || job.planning.phase === 'TARGETED_REPAIR'
    || (job.planning.phase === 'DIVERSITY_AUDIT' && job.planning.repairAttempted)) {
    throw new PreviewAcceptanceError('Preview acceptance does not authorize legacy preparation, planning repair or re-audit. Start a fresh cached-input check.');
  }
}

/** Check before dispatch; cached reuse never enters this boundary. */
export function assertPreviewAcceptanceProvider(meta: ProviderAttemptMetadata) {
  if (!isPreviewAcceptance() || !meta.portfolioId) return;
  if (meta.endpoint === 'responses' && meta.model === 'gpt-6.1-sol'
    && ['creative-plan', 'portfolio-audit'].includes(meta.stage)) return;
  if (meta.endpoint === 'images' && meta.stage === 'image'
    && meta.model === 'gpt-image-2.5-sunburst' && meta.n === 1 && meta.purpose === 'staging-smoke'
    && meta.dimensions === '1024x1280' && meta.quality === 'high') return;
  throw new PreviewAcceptanceError(`Preview acceptance blocked ${meta.stage} before dispatch. Preparation must be cached; only the initial planner, initial audit and two Sunburst images are permitted.`);
}
