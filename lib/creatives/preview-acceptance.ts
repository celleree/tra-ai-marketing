import type { ProviderAttemptMetadata } from '@/lib/ai/provider-usage';
import type { ValidGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import type { CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { approvedPreviewProviderContext, isApprovedPreviewPortfolio, PREVIEW_TEST_APPROVAL } from '@/lib/creatives/preview-test-approval';
import { hasNormalPreviewPortfolio, isNormalPreviewProvider, isPreviewTestPortfolio } from '@/lib/creatives/preview-portfolio-scope';

/** Existing server purpose scopes this restriction to Preview acceptance only. */
export const isPreviewAcceptance = () => process.env.VERCEL_ENV === 'preview'
  && process.env.TRA_IMAGE_PURPOSE === 'staging-smoke';
/** Unscoped endpoints retain their Preview policy; normal authenticated Create is isolated from QA. */
export const isPreviewAcceptanceOperation = () => isPreviewAcceptance() && !hasNormalPreviewPortfolio();

export class PreviewAcceptanceError extends Error {
  readonly status = 409;
}
export const PREVIEW_NO_LOGO_DIRECTION = 'This explicitly unbranded Preview test excludes logo verification. Do not render, invent or redraw any logo, wordmark, brand mark or logo-shaped placeholder. Do not substitute header artwork. No logo overlay will be added.';

export function assertPreviewAcceptanceRequest(request: ValidGenerateCreativeRequest, frozen = false) {
  if (!isPreviewAcceptance()) return;
  const validLogoChoice = request.previewOmitBrandLogo === true ? !request.brandLogoMediaId : Boolean(request.brandLogoMediaId);
  if (request.variationCount !== 2 || request.placement !== 'PORTRAIT_4_5' || !validLogoChoice
    || request.sourceAssets.filter(source => source.role === 'TRA_VIDEO').length !== 1
    || request.sourceAssets.filter(source => source.role === 'LAYOUT_REFERENCE').length !== 1
    || request.sourceAssets.some(source => !['TRA_VIDEO', 'LAYOUT_REFERENCE'].includes(source.role))
    || (frozen ? !request.reviewHandoff?.choices.frames?.length : !request.videoReview)) {
    throw new PreviewAcceptanceError('Preview acceptance requires exactly two 4:5 creatives, the original logo or explicit no-logo test choice, one completed video, one supplied layout reference and a saved manually selected frame pool.');
  }
}

export function assertPreviewAcceptanceJob(job: CreativePortfolioJob) {
  if (!isPreviewAcceptance() || !isPreviewTestPortfolio(job)) return;
  assertPreviewAcceptanceRequest(job.request, true);
  if (job.sourceCompositionVersion !== 2 || job.videoPreparationVersion !== 1
    || job.planning.phase === 'TARGETED_REPAIR'
    || (job.planning.phase === 'DIVERSITY_AUDIT' && job.planning.repairAttempted)) {
    throw new PreviewAcceptanceError('Preview acceptance does not authorize legacy preparation, planning repair or re-audit. Start a fresh cached-input check.');
  }
  if (!isApprovedPreviewPortfolio(job)) throw new PreviewAcceptanceError('The reserved Preview test identity or frozen inputs changed. No ordinary Create admission is authorized for this test.');
}

/** Check before dispatch; cached reuse never enters this boundary. */
export function assertPreviewAcceptanceProvider(meta: ProviderAttemptMetadata) {
  if (!isPreviewAcceptance()) return;
  if (isNormalPreviewProvider(meta)) return;
  const approved = approvedPreviewProviderContext(meta);
  if (approved && meta.endpoint === 'responses' && meta.model === 'gpt-6-luna'
    && meta.stage === 'video-human-selection') return;
  if (approved && meta.endpoint === 'responses' && meta.model === 'gpt-6.1-sol'
    && ['creative-plan', 'portfolio-audit'].includes(meta.stage)) return;
  if (approved && PREVIEW_TEST_APPROVAL.creativeIds.includes(meta.creativeId ?? '') && meta.endpoint === 'images' && meta.stage === 'image'
    && meta.model === 'gpt-image-2.5-sunburst' && meta.n === 1 && meta.purpose === 'staging-smoke'
    && meta.dimensions === '1024x1280' && meta.quality === 'high') return;
  throw new PreviewAcceptanceError(`Preview acceptance blocked ${meta.stage} before dispatch. Only the approved test's two new frame assessments, initial planner, initial audit and two Sunburst images are permitted; layout preparation must be reused.`);
}
