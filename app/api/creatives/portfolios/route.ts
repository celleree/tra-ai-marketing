import { BatchControlsError } from '@/lib/creatives/batch-controls-error';
import { recoverBoundCaseCrop, boundCaseCropRecoverySlot, reviseBoundCaseCrop, assessRevisedBoundCaseCrop, authorizeRevisedBoundCaseImage, validBoundPortraitCropRequest, BoundPortraitRecoveryError } from '@/lib/creatives/portfolio-bound-case-recovery';
import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { validateGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import { MAX_PORTFOLIO_CREATIVES } from '@/lib/creatives/planned';
import { assertGenerationAvailable, CreativeGenerationPreparationError } from '@/lib/creatives/generation-sources';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { isPortfolioId } from '@/lib/creatives/portfolio-job-parser';
import { retryPortfolioWork, type CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { portfolioProgress } from '@/lib/creatives/portfolio-progress';
import { readPortfolioCreatives } from '@/lib/creatives/portfolio-results';
import { advanceCreativePortfolio } from '@/lib/creatives/portfolio-execution';
import { parseSubmissionId, SUBMISSION_HEADER, SubmissionConflictError } from '@/lib/creatives/submission-id';
import { ReviewSelectionError } from '@/lib/video/review-selection';
import { isPreviewAcceptance, PreviewAcceptanceError } from '@/lib/creatives/preview-acceptance';
import { withNormalPreviewPortfolio, isPreviewTestPortfolio } from '@/lib/creatives/preview-portfolio-scope';
import { isApprovedPreviewPortfolio, PREVIEW_TEST_APPROVAL } from '@/lib/creatives/preview-test-approval';
import { initializeApprovedPreviewPortfolio } from '@/lib/creatives/preview-test-initialization';
import { assertPreviewAdvanceResponse, isApprovedPreviewAdvanceId, previewAdvanceReadback, PREVIEW_ADVANCE_HEADER,
  stopApprovedPreviewAdvance, withApprovedPreviewAdvance } from '@/lib/creatives/preview-advance-fence';

export const runtime = 'nodejs';
export const maxDuration = 300;
const json = (body: object, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', ...headers } });
const result = async (saved: CreativePortfolioJob, status = 200, error?: string, retryAfterSeconds?: number, previous?: string) => {
  const job = await previewAdvanceReadback(saved, previous);
  const recoverySlot = process.env.VERCEL_ENV === 'preview' ? boundCaseCropRecoverySlot(job) : undefined;
  return json({ job: portfolioProgress(job),
      creatives: await readPortfolioCreatives(job),
      ...(recoverySlot !== undefined ? { boundCaseCropRecoverySlot: recoverySlot } : {}),
      ...(isApprovedPreviewPortfolio(job) ? { previewPreparationApproved: true } : {}),
      ...(isPreviewAcceptance() && job.id === PREVIEW_TEST_APPROVAL.previousPortfolioId && job.previewAcceptanceError
        ? { previewInitializationAvailable: true } : {}),
      ...(job.request.previewOmitBrandLogo ? { previewOmitBrandLogo: true } : {}),
    ...(isApprovedPreviewPortfolio(job) && job.planning.phase === 'INITIAL_PLAN' && !job.planningError && !job.previewAcceptanceError
      && job.planning.preparation.previewPreflightReady ? { preflightReady: true } : {}), ...(error ? { error } : {}) },
    status, retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {});
};
const failure = (error: unknown) => {
  if (error instanceof BatchControlsError) return json({ error: error.message }, error.status);
  if (error instanceof SyntaxError) return json({ error: 'Invalid JSON body.' }, 400);
  if (error instanceof SubmissionConflictError) return json({ error: error.message }, 409);
  if (error instanceof ReviewSelectionError) return json({ error: error.message }, error.status);
  if (error instanceof PreviewAcceptanceError) return json({ error: error.message }, error.status);
  if (error instanceof CreativeGenerationPreparationError) return json({ error: error.message }, error.status);
  console.error('Creative portfolio request failed', error);
  return json({ error: 'Creative portfolio request failed. Reload its saved progress before continuing.' }, 500);
};

export async function GET(request: Request) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  try {
    const id = new URL(request.url).searchParams.get('id') ?? '';
    if (!isPortfolioId(id)) return json({ error: 'Invalid portfolio ID.' }, 400);
    const job = await readCreativePortfolio(id);
    return job ? await result(job, 200, undefined, undefined, request.headers.get(PREVIEW_ADVANCE_HEADER) ?? undefined) : json({ error: 'Portfolio not found.' }, 404);
  } catch (error) { return failure(error); }
}

/** Creation persists identities only. No quota reservation, planning or paid rendering. */
export async function POST(request: Request) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  try {
    const body = await request.json();
    if (body?.action === 'initialize-approved-preview') {
      if (Object.keys(body).some(key => !['action', 'sourcePortfolioId'].includes(key)) || typeof body.sourcePortfolioId !== 'string') {
        return json({ error: 'Invalid approved Preview initialization.' }, 400);
      }
      return await result(await initializeApprovedPreviewPortfolio(body.sourcePortfolioId), 201);
    }
    const parsed = validateGenerateCreativeRequest(body, MAX_PORTFOLIO_CREATIVES);
    if (!parsed.success) return json({ error: parsed.error }, 400);
    const submissionId = parseSubmissionId(request.headers.get(SUBMISSION_HEADER));
    if (!submissionId) return json({ error: 'A valid Idempotency-Key is required to create a portfolio.' }, 400);
    assertGenerationAvailable(parsed.data);
    return await result(await createCreativePortfolio(parsed.data, undefined, undefined, { operatorId: access.userId, id: submissionId }), 201);
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  const deadlineAtMs = Date.now() + 290_000;
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.id !== 'string' || !isPortfolioId(body.id)
      || !['advance', 'retry', 'recover-bound-case-crop', 'assess-bound-case-crop', 'generate-bound-case-crop'].includes(body.action)
      || (body.action === 'advance' && body.slotIndex !== undefined)
      || (body.action === 'recover-bound-case-crop' && (!Number.isInteger(body.slotIndex) || body.slotIndex < 1 || body.slotIndex > MAX_PORTFOLIO_CREATIVES
        || Object.keys(body).some(key => !['id', 'action', 'slotIndex', 'revision'].includes(key))
        || (body.revision !== undefined && !validBoundPortraitCropRequest(body.revision))))
      || (['assess-bound-case-crop','generate-bound-case-crop'].includes(body.action) && (!Number.isInteger(body.slotIndex) || body.slotIndex < 1 || body.slotIndex > MAX_PORTFOLIO_CREATIVES
        || Object.keys(body).some(key=>!['id','action','slotIndex','approved'].includes(key)) || body.approved!==true))
      || (body.action === 'retry' && body.slotIndex !== null
        && (!Number.isInteger(body.slotIndex) || body.slotIndex < 1 || body.slotIndex > MAX_PORTFOLIO_CREATIVES))) {
      return json({ error: 'Invalid portfolio action.' }, 400);
    }
    const execute = async (nonce?: string) => {
      const job = await readCreativePortfolio(body.id);
      if (!job) return json({ error: 'Portfolio not found.' }, 404);
      if (body.action === 'recover-bound-case-crop') {
        if (process.env.VERCEL_ENV !== 'preview') return json({ error: 'Bound frame recovery is available only in Preview.' }, 409);
        try { return await result(body.revision ? await reviseBoundCaseCrop(body.id,body.slotIndex,body.revision) : await recoverBoundCaseCrop(body.id, body.slotIndex)); }
        catch (error) { return json({error: body.revision ? (error instanceof BoundPortraitRecoveryError ? error.message : 'Revised crop preparation is unavailable; no provider call started.') : error instanceof Error ? error.message : 'Bound frame recovery is unavailable.'},409); }
      }
      if (['assess-bound-case-crop','generate-bound-case-crop'].includes(body.action)) {
        if (process.env.VERCEL_ENV!=='preview') return json({error:'Bound crop testing is available only in Preview.'},409);
        try {
          if (body.action==='assess-bound-case-crop') return await result(await withNormalPreviewPortfolio(job,access.userId,()=>assessRevisedBoundCaseCrop(body.id,body.slotIndex,access.userId,undefined,{deadlineAtMs})));
          await authorizeRevisedBoundCaseImage(body.id,body.slotIndex);
          const step=await advanceCreativePortfolio(body.id,access.userId,request.url,undefined,{deadlineAtMs});
          return await result(step.job,step.status,step.error,step.retryAfterSeconds);
        } catch(error) { return json({error:error instanceof BoundPortraitRecoveryError ? error.message : 'Bound crop step is unavailable. Reload saved progress; no repeat call is authorized.'},409); }
      }
      if (body.action === 'retry') {
        const target=body.slotIndex===null ? null : job.slots[body.slotIndex-1];
        if(target?.videoSelection?.version===2 && target.videoSelection.portraitCropRevision) return json({error:'Revised portrait work does not authorize repeated paid attempts. Inspect the saved diagnostic.'},409);
        if (isPreviewAcceptance() && isPreviewTestPortfolio(job)) throw new PreviewAcceptanceError('Preview acceptance does not authorize paid retries. Saved results remain available.');
        const retryable = body.slotIndex === null ? !job.snapshot && job.planningError
          : job.snapshot && job.slots.some(slot => slot.index === body.slotIndex && slot.status === 'RETRY_REQUIRED');
        if (job.lease || !retryable) return json({ error: 'This work cannot be retried in its current state. Reload its progress.' }, 409);
        return await result(await updateCreativePortfolio(body.id, current => retryPortfolioWork(current, body.slotIndex)));
      }
      const step = await advanceCreativePortfolio(body.id, access.userId, request.url, undefined, { deadlineAtMs });
      const failed = Boolean(step.error || step.job.previewAcceptanceError || step.job.planningError
        || step.job.slots.some(slot => ['RETRY_REQUIRED', 'BLOCKED'].includes(slot.status))
        || (step.job.planning.phase === 'INITIAL_PLAN' && ['FAILED', 'RETRY_REQUIRED'].includes(step.job.planning.preparation.videoProgress?.phase ?? '')));
      if (nonce && failed) await stopApprovedPreviewAdvance(body.id);
      const response = await result(step.job, step.status, step.error, step.retryAfterSeconds, nonce);
      if (!nonce || failed || step.job.lease || response.status !== 200
        || (step.job.planning.phase === 'INITIAL_PLAN' && step.job.planning.preparation.videoProgress?.busy)) return response;
      const value = await response.json(); // Complete serialization before exposing continuation authority.
      await assertPreviewAdvanceResponse(nonce);
      return json({ ...value, previewAdvanceNonce: nonce }, response.status);
    };
    return body.action === 'advance' && isApprovedPreviewAdvanceId(body.id)
      ? await withApprovedPreviewAdvance(body.id, request.headers.get(PREVIEW_ADVANCE_HEADER) ?? undefined, execute)
      : await execute();
  } catch (error) { return failure(error); }
}
