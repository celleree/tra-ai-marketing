import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { parseCreativePortfolioJob } from '@/lib/creatives/portfolio-job-parser';
import { readCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { advancePlanningSourceAnalysis } from '@/lib/creatives/planning-source-composition';
import { PreviewAcceptanceError, isPreviewAcceptance } from '@/lib/creatives/preview-acceptance';
import { PREVIEW_TEST_APPROVAL, isApprovedPreviewPortfolio, previewTestRequestHash } from '@/lib/creatives/preview-test-approval';
import { getVideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

/** Copy only the approved frozen inputs and completed preparation; never reopen the stopped run. */
export async function initializeApprovedPreviewPortfolio(sourcePortfolioId: string, storage = getVideoIntelligenceStorage()) {
  const deny = () => new PreviewAcceptanceError('Approved Preview initialization could not validate the preserved run and completed preparation. No provider work was started.');
  if (!isPreviewAcceptance() || sourcePortfolioId !== PREVIEW_TEST_APPROVAL.previousPortfolioId) throw deny();
  const existing = await readCreativePortfolio(PREVIEW_TEST_APPROVAL.portfolioId, storage);
  if (existing) {
    if (!isApprovedPreviewPortfolio(existing)) throw deny();
    return existing;
  }
  const previous = await readCreativePortfolio(sourcePortfolioId, storage);
  if (!previous || previewTestRequestHash(previous.request) !== PREVIEW_TEST_APPROVAL.requestSha256
    || !previous.previewAcceptanceError || !previous.planningError || previous.lease || previous.snapshot
    || previous.sourceCompositionVersion !== 2 || previous.videoPreparationVersion !== 1
    || previous.planning.phase !== 'INITIAL_PLAN' || previous.slots.length !== 2
    || previous.slots.some(slot => slot.status !== 'PENDING' || slot.videoSelection)) throw deny();
  const preparation = previous.planning.preparation;
  if (!preparation.sourceAnalysis?.entries.length || preparation.sourceAnalysis.entries.some(entry => !entry.result)
    || preparation.sourceAnalysis.entries.some(entry => entry.source.role === 'TRA_VIDEO' && entry.result?.kind !== 'VIDEO_INTELLIGENCE')
    || preparation.videoDependencies?.length !== 1 || preparation.videoDependencies.some(dependency => !dependency.completed)) throw deny();
  // This validates source bytes, context, analyzer identities and every completed result without purchasing a replacement.
  const validated = await advancePlanningSourceAnalysis(previous.request, preparation.sourceAnalysis, () => { throw deny(); });
  if (!validated.complete) throw deny();
  const job = newCreativePortfolio(structuredClone(previous.request));
  job.id = PREVIEW_TEST_APPROVAL.portfolioId;
  job.slots.forEach((slot, index) => { slot.creativeId = PREVIEW_TEST_APPROVAL.creativeIds[index]; });
  job.planning = { phase: 'INITIAL_PLAN', preparation: { quotaReserved: false, sourceAnalysis: validated.state,
    ...(preparation.videoDependencies ? { videoDependencies: structuredClone(preparation.videoDependencies) } : {}) } };
  const bytes = Buffer.from(JSON.stringify(job));
  parseCreativePortfolioJob(bytes, job.id);
  const key = `creative-portfolios/v1/${job.id}.json`;
  try {
    if (await storage.write(key, bytes, null)) return job;
  } catch {
    // A lost creation acknowledgement may only reconcile this fixed identity, never create another run.
  }
  const saved = await readCreativePortfolio(job.id, storage);
  if (!saved || !isApprovedPreviewPortfolio(saved)) throw deny();
  return saved;
}
