import { withProviderUsageContext } from '@/lib/ai/provider-telemetry';
import { reserveOperatorQuota } from '@/lib/quotas/operator-quota';
import { reconstructPinnedPortfolioPortrait } from '@/lib/creatives/portfolio-portrait-diagnostic';
import { providerPortraitIdentity, providerPortraitInput } from '@/lib/video/provider-portrait';
import { prepareProviderVideoFrames } from '@/lib/video/source-overlay';
import { parseSourceOverlayDecision } from '@/lib/video/source-overlay-contract';
import type { PortraitCropRevision } from '@/lib/video/provider-portrait-contract';
import { readCandidateSuitability, assessCandidateWithCache, isSuitableCandidate } from '@/lib/video/candidate-suitability';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { caseReviewChoices, validateCaseAmendment } from '@/lib/creatives/portfolio-case-amendment';
import { claimCreativePortfolio, failPortfolioWork, releasePortfolioWork } from '@/lib/creatives/portfolio-job';
import type { CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { assertNoImageAttempts } from '@/lib/creatives/image-attempt-store';
import { listCreatives } from '@/lib/creatives/storage';
import { isPreviewTestPortfolio } from '@/lib/creatives/preview-portfolio-scope';
import { CANDIDATE_HUMAN_FRAME_SELECTION_POLICY } from '@/lib/video/human-frame-selection';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

function assertRecoverable(job: CreativePortfolioJob, slotIndex: number) {
  const slot = job.slots.find(item => item.index === slotIndex);
  if (!job.videoCaseAmendment || !job.snapshot || job.planning.phase !== 'READY_TO_RENDER'
    || job.videoPreparationVersion !== 1 || job.lease || job.previewAcceptanceError || isPreviewTestPortfolio(job)
    || !slot || slot.status !== 'BLOCKED' || slot.boundCaseCropRecovery
    || !slot.error?.startsWith('No suitable human frame was found.')
    || slot.videoSelection?.version !== 2 || slot.videoSelection.selection
    || slot.videoSelection.retryAuthorization || slot.videoSelection.selectionPolicy !== CANDIDATE_HUMAN_FRAME_SELECTION_POLICY
    || job.slots.some(other => other.index !== slotIndex && other.status !== 'SAVED')) {
    throw new Error('Only a blocked legacy bound-frame slot with all other outputs saved can be recovered once.');
  }
  validateCaseAmendment(job, job.videoCaseAmendment);
  if (caseReviewChoices(job, slotIndex)?.frames?.length !== 1) throw new Error('The exact confirmed frame is required.');
  return slot;
}

/** UI availability hint only; applying recovery still checks target attempts and persisted outputs. */
export function boundCaseCropRecoverySlot(job: CreativePortfolioJob): number | undefined {
  const index = job.slots.find(slot => slot.status === 'BLOCKED')?.index;
  if (index === undefined) return undefined;
  try { assertRecoverable(job, index); return index; } catch { return undefined; }
}

/** Explicit non-paid preparation only. No cache/ledger deletion, provider dispatch or automatic Resume. */
export async function recoverBoundCaseCrop(id: string, slotIndex: number,
  storage: VideoIntelligenceStorage = getVideoIntelligenceStorage()) {
  const existing = await readCreativePortfolio(id, storage);
  if (!existing) throw new Error('Creative portfolio was not found.');
  // An uncertain response can be read back/repeated without resetting or redispatching work.
  if (existing.slots.find(slot => slot.index === slotIndex)?.boundCaseCropRecovery) return existing;
  const slot = assertRecoverable(existing, slotIndex);
  // BLOCKED is terminal for ordinary advance; all other slots are SAVED, so no renderer can race these reads.
  await assertNoImageAttempts(`portfolio:${id}`, storage, slot.creativeId);
  if ((await listCreatives()).some(record => record.id === slot.creativeId)) {
    throw new Error('A saved result exists for this slot. Preserve it and reload progress.');
  }
  return updateCreativePortfolio(id, current => {
    assertRecoverable(current, slotIndex);
    if (!isDeepStrictEqual(current, existing)) throw new Error('Portfolio changed during recovery. Reload before continuing.');
    const next = structuredClone(current), target = next.slots.find(item => item.index === slotIndex)!;
    target.boundCaseCropRecovery = { version: 1, previousError: target.error! };
    target.status = 'PENDING'; delete target.error;
    // Preserve the frozen model/reuse context; the new contract has a separate assessment cache.
    next.updatedAtMs = Date.now();
    return next;
  }, storage, { boundCaseCropRecoverySlot: slotIndex });
}

export type BoundPortraitCropRequest = {
  frameId: string; timestampMs: number; sourceVideoContentHash: string; previousProviderPngSha256: string;
  sourcePngSha256: string; revisedProviderPngSha256: string; edge: 'TOP' | 'BOTTOM' | 'LEFT' | 'RIGHT'; removePermille: number;
};
export class BoundPortraitRecoveryError extends Error {}
const denyPortrait = (message: string): never => { throw new BoundPortraitRecoveryError(message); };
const portraitSlot = (job: CreativePortfolioJob, index: number) => {
  const slot = job.slots[index - 1], selected = slot?.videoSelection;
  if (!job.videoCaseAmendment || !job.snapshot || job.planning.phase !== 'READY_TO_RENDER' || job.videoPreparationVersion !== 1
    || job.previewAcceptanceError || isPreviewTestPortfolio(job) || !slot || selected?.version !== 2 || !selected.selection || !selected.providerPortrait
    || job.slots.some(other => other.index !== index && other.status !== 'SAVED')) return denyPortrait('A paused bound case with all other creatives saved is required.');
  validateCaseAmendment(job, job.videoCaseAmendment);
  const binding = selected.selection.candidateBindings?.[0], caseFrame = caseReviewChoices(job, index)?.frames?.[0];
  if (!binding || !caseFrame || selected.selection.candidateBindings?.length !== 1 || binding.frameId !== caseFrame.frameId
    || binding.timestampMs !== caseFrame.timestampMs) return denyPortrait('The confirmed case frame must remain unchanged.');
  return {slot, selected, binding};
};
async function noTargetImage(job: CreativePortfolioJob, index: number, storage: VideoIntelligenceStorage) {
  await assertNoImageAttempts(`portfolio:${job.id}`, storage, job.slots[index - 1].creativeId);
  if ((await listCreatives()).some(record => record.id === job.slots[index - 1].creativeId)) denyPortrait('A saved target image already exists. Preserve it.');
}
export function proposedPortraitOverlay(edge: string, removePermille: number) {
  const overlay = parseSourceOverlayDecision({version:2, status:'EDGE_CROP', edge, removePermille, overlayDepthPermille: removePermille});
  if (!overlay || overlay.status !== 'EDGE_CROP') return denyPortrait('Choose one edge and a removal depth from 1 to 450 permille.');
  return overlay;
}
/** One explicit revision on the same case/frame; original pin, assessment reference and legacy history survive. */
export async function reviseBoundCaseCrop(id: string, index: number, request: BoundPortraitCropRequest, storage = getVideoIntelligenceStorage()) {
  const existing = await readCreativePortfolio(id, storage); if (!existing) return denyPortrait('Saved portfolio not found.');
  const {slot, selected, binding} = portraitSlot(existing, index), overlay = proposedPortraitOverlay(request.edge, request.removePermille);
  const old = selected.providerPortrait!, revision = selected.portraitCropRevision;
  if (revision) {
    if (revision.previousPortrait.providerPngSha256 === request.previousProviderPngSha256 && old.providerPngSha256 === request.revisedProviderPngSha256
      && old.sourcePngSha256 === request.sourcePngSha256 && binding.frameId === request.frameId && binding.timestampMs === request.timestampMs
      && selected.selection!.sourceVideoContentHash === request.sourceVideoContentHash && isDeepStrictEqual(revision.revisedOverlay, overlay)) return existing;
    return denyPortrait('This case already has a different crop revision. No further reset or retry is authorized.');
  }
  if (existing.lease || slot.status !== 'RETRY_REQUIRED' || old.verified || old.retryAuthorized
    || !slot.error?.startsWith('The actual retained portrait PNG did not pass')) return denyPortrait('Only the completed failed retained-portrait check can be revised once.');
  if (request.previousProviderPngSha256 !== old.providerPngSha256 || request.sourcePngSha256 !== old.sourcePngSha256
    || request.sourceVideoContentHash !== selected.selection!.sourceVideoContentHash || request.frameId !== binding.frameId || request.timestampMs !== binding.timestampMs) return denyPortrait('The requested source/pin differs from the saved case. Reload its diagnostic.');
  const identity = providerPortraitIdentity(selected.selection!, old, selected.selectionModel);
  const cached = await readCandidateSuitability(identity, {storage, deadlineAtMs:Date.now()});
  if (cached.status !== 'COMPLETE' || cached.assessment.sourceOverlay.status !== 'UNSAFE'
    || !isSuitableCandidate({...cached.assessment, sourceOverlay:{version:2,status:'CLEAN'}})) return denyPortrait('Recovery requires completed overlay rejection with usable human quality.');
  await noTargetImage(existing, index, storage);
  const rebuilt = await reconstructPinnedPortfolioPortrait(existing, index).catch(() => denyPortrait('Exact pinned source reconstruction failed. No crop changed.'));
  const [prepared] = await prepareProviderVideoFrames([{...rebuilt.frame, sourceOverlay:overlay}]);
  const portrait = await providerPortraitInput(selected.selection!, prepared, selected.selectionModel);
  if (portrait.state.providerPngSha256 !== request.revisedProviderPngSha256 || portrait.state.providerPngSha256 === old.providerPngSha256) return denyPortrait('Revised PNG must match the inspected preview and differ from the failed pin.');
  const history: PortraitCropRevision = {version:1, previousPortrait:structuredClone(old), previousOverlay:selected.selection!.sourceOverlays![0],
    previousAssessmentKeySha256:createHash('sha256').update(JSON.stringify(identity)).digest('hex'), previousError:slot.error!,
    originalWidth:rebuilt.originalMetadata.width!, originalHeight:rebuilt.originalMetadata.height!, frameId:binding.frameId,
    timestampMs:binding.timestampMs, sourceVideoContentHash:selected.selection!.sourceVideoContentHash,
    revisedOverlay:overlay, assessmentAttempted:false, imageAuthorized:false};
  return updateCreativePortfolio(id, current => {
    if (!isDeepStrictEqual(current, existing)) return denyPortrait('Saved state changed while preparing crop. Reload progress.');
    const v = current.slots[index-1].videoSelection as typeof selected;
    v.selection!.sourceOverlays = [overlay]; v.providerPortrait = portrait.state; v.portraitCropRevision = history;
    current.slots[index-1].status = 'PENDING'; delete current.slots[index-1].error; current.updatedAtMs = Date.now(); return current;
  }, storage, {boundCaseCropRevisionSlot:index});
}
/** At most one model attempt; complete receipts can reconcile without purchasing again. Never renders an image. */
export async function assessRevisedBoundCaseCrop(id: string, index: number, operatorId: string, storage = getVideoIntelligenceStorage(),
  dependencies: {request?: typeof fetch; deadlineAtMs?: number} = {}) {
  const existing = await readCreativePortfolio(id, storage); if (!existing) return denyPortrait('Saved portfolio not found.');
  const {slot, selected} = portraitSlot(existing,index), revision = selected.portraitCropRevision;
  if (!revision || revision.imageAuthorized || slot.status === 'SAVED') return denyPortrait('Prepare a revised crop before its separate assessment.');
  if (existing.lease && existing.lease.expiresAtMs > Date.now()) return existing;
  if (existing.lease && existing.lease.slotIndex !== index) return denyPortrait('Another saved step owns this lease. Reload progress.');
  const identity = providerPortraitIdentity(selected.selection!, selected.providerPortrait!, selected.selectionModel);
  if (selected.selectionModel !== 'gpt-6-luna') return denyPortrait('The bounded assessment authorizes only standard GPT-6 Luna.');
  const cache = {storage, deadlineAtMs:dependencies.deadlineAtMs ?? Date.now()+290_000, request:dependencies.request, standardTier:true};
  const known = await readCandidateSuitability(identity,cache);
  if (selected.providerPortrait!.verified && known.status === 'COMPLETE') return existing;
  if (revision.assessmentAttempted && known.status !== 'COMPLETE') {
    if (!existing.lease) return denyPortrait('The single assessment attempt is unfinished or uncertain. No repeat call is authorized.');
    return updateCreativePortfolio(id, current => {
      if (!isDeepStrictEqual(current, existing)) return denyPortrait('Assessment state changed. Reload progress.');
      // Only release our expired assessment lease; the durable intent forbids provider replay.
      current.lease = null;
      current.slots[index - 1].status = 'RETRY_REQUIRED';
      current.slots[index - 1].error = 'The single assessment attempt is unfinished or uncertain. No repeat call is authorized.';
      current.updatedAtMs = Date.now();
      return current;
    }, storage);
  }
  await noTargetImage(existing,index,storage);
  const token = randomUUID();
  const claimed = await updateCreativePortfolio(id,current => {
    if (!isDeepStrictEqual(current,existing)) return denyPortrait('Assessment state changed. Reload progress.');
    // A completed receipt (or no dispatch intent) permits a new checkpoint lease, never a replay.
    current.lease = null;
    current.slots[index-1].status='PENDING'; delete current.slots[index-1].error;
    return claimCreativePortfolio(current,Date.now(),token).job;
  },storage);
  if (claimed.lease?.id !== token || claimed.lease.slotIndex !== index) return claimed;
  try {
    let assessment = known;
    if (assessment.status !== 'COMPLETE') {
      const rebuilt = await reconstructPinnedPortfolioPortrait(claimed,index);
      const quota = await reserveOperatorQuota({operatorId,group:'VIDEO_SELECTION',units:1},{storage});
      if (!quota.allowed) { await updateCreativePortfolio(id,c=>releasePortfolioWork(c,token),storage); return denyPortrait('Assessment quota reached; no model call started.'); }
      await updateCreativePortfolio(id,current => {
        if (current.lease?.id !== token || current.lease.expiresAtMs <= Date.now()) return denyPortrait('Assessment lease changed.');
        (current.slots[index-1].videoSelection as typeof selected).portraitCropRevision!.assessmentAttempted=true; return current;
      },storage);
      assessment = await withProviderUsageContext({runId:`portfolio:${id}`,portfolioId:id,creativeId:slot.creativeId},
        () => assessCandidateWithCache(identity,rebuilt.prepared.providerBuffer,cache));
    }
    return await updateCreativePortfolio(id,current => {
      if (current.lease?.id !== token || current.lease.expiresAtMs <= Date.now()) return denyPortrait('Assessment lease changed before receipt.');
      const v = current.slots[index-1].videoSelection as typeof selected; v.portraitCropRevision!.assessmentAttempted=true;
      if (assessment.status !== 'COMPLETE' || !isSuitableCandidate(assessment.assessment) || assessment.assessment.sourceOverlay.status !== 'CLEAN') {
        return failPortfolioWork(current,token,'Revised portrait assessment did not pass or is uncertain. Inspect the saved diagnostic; no retry or image call is authorized.');
      }
      v.providerPortrait!.verified=true; return releasePortfolioWork(current,token);
    },storage);
  } catch (error) {
    await updateCreativePortfolio(id, current => {
      if (current.lease?.id !== token) return current;
      if (current.lease.expiresAtMs > Date.now()) return failPortfolioWork(current, token, 'Revised portrait assessment is unconfirmed. No repeat paid call is authorized.');
      current.lease = null;
      current.slots[index - 1].status = 'RETRY_REQUIRED';
      current.slots[index - 1].error = 'Revised portrait assessment is unconfirmed. Reconcile its saved receipt; no repeat paid call is authorized.';
      current.updatedAtMs = Date.now();
      return current;
    }, storage);
    throw error;
  }
}
/** Separate explicit image intent. Existing image attempt ledger continues to enforce no duplicate primary/fallback. */
export async function authorizeRevisedBoundCaseImage(id: string,index: number,storage=getVideoIntelligenceStorage()) {
  const existing = await readCreativePortfolio(id,storage); if(!existing) return denyPortrait('Saved portfolio not found.');
  const {slot,selected}=portraitSlot(existing,index), revision=selected.portraitCropRevision;
  if(revision?.imageAuthorized) return existing;
  if(existing.lease || slot.status!=='PENDING' || !revision?.assessmentAttempted || !selected.providerPortrait!.verified) return denyPortrait('A passed revised-PNG assessment is required before separate image generation.');
  const cached=await readCandidateSuitability(providerPortraitIdentity(selected.selection!,selected.providerPortrait!,selected.selectionModel),{storage,deadlineAtMs:Date.now()});
  if(cached.status!=='COMPLETE'||!isSuitableCandidate(cached.assessment)||cached.assessment.sourceOverlay.status!=='CLEAN') return denyPortrait('The verified portrait receipt is unavailable. No image is authorized.');
  await noTargetImage(existing,index,storage);
  return updateCreativePortfolio(id,current=>{
    if(!isDeepStrictEqual(current,existing)) return denyPortrait('State changed before image intent. Reload progress.');
    (current.slots[index-1].videoSelection as typeof selected).portraitCropRevision!.imageAuthorized=true; return current;
  },storage);
}

export function validBoundPortraitCropRequest(value: unknown): value is BoundPortraitCropRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const x = value as BoundPortraitCropRequest;
  return Object.keys(x).sort().join(',') === ['frameId','timestampMs','sourceVideoContentHash','previousProviderPngSha256','sourcePngSha256','revisedProviderPngSha256','edge','removePermille'].sort().join(',')
    && /^video-frame:[a-f0-9]{64}$/.test(x.frameId) && Number.isSafeInteger(x.timestampMs) && x.timestampMs>=0
    && [x.sourceVideoContentHash,x.previousProviderPngSha256,x.sourcePngSha256,x.revisedProviderPngSha256].every(v=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v))
    && ['TOP','BOTTOM','LEFT','RIGHT'].includes(x.edge) && Number.isSafeInteger(x.removePermille) && x.removePermille>=1 && x.removePermille<=450;
}
