import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import type { VideoReviewHandoff } from '@/lib/creatives/review-handoff';
import { reviewSourceSha256 } from '@/lib/video/review-selection';
import { portfolioRequest, portfolioSnapshot } from './creative-portfolio';
import { frame, video } from './video-review-selection';
import { referenceCandidate } from './reference-catalog';

export function videoCasePortfolio() {
  const segments = [{ segmentIndex: 0, startMs: 5000, endMs: 9000,
    text: 'My debt went from $42,000 to $250. This was my individual result.' },
  { segmentIndex: 1, startMs: 10000, endMs: 15000,
    text: 'TRA reduced what I owed by 78%. I felt relieved about my case.' }];
  const frames = [frame(6), frame(12)];
  const claimSnapshots = segments.map(segment => ({ reference: { type: 'VIDEO_TRANSCRIPT' as const,
    startSegmentIndex: segment.segmentIndex, endSegmentIndex: segment.segmentIndex }, wording: segment.text,
    context: { type: 'VIDEO_TRANSCRIPT' as const, segments: [segment] } }));
  const choices = { video, frames, claims: claimSnapshots.map(claim => claim.reference), companyProfile: null };
  const guidance = { usage: 'DRAFT_CREATIVE_GUIDANCE_ONLY', grantsAdvertisingApproval: false, providerEligible: false,
    video, frameMode: 'MANUAL_CLOSED_POOL', frames: frames.map((binding, index) => ({ binding,
      observationSourceFrameId: binding.frameId, observationIsExactFrame: true,
      observation: { sceneType: 'PERSON', summary: index ? 'Bearded person outdoors' : 'Bald person indoors',
        composition: 'Portrait', visibleText: [], topics: ['person'], uncertainties: [] } })),
    statements: claimSnapshots, transcriptContext: { segments }, companyProfile: null };
  const frozen = { version: 1, artifactType: 'VIDEO_REVIEW_HANDOFF', draftId: `review_${'4'.repeat(32)}`,
    revision: 'source-revision', choices, claimSnapshots, operatorSelectedSourceGuidance: guidance };
  const handoff = { ...frozen, handoffSha256: reviewSourceSha256(frozen) } as unknown as VideoReviewHandoff;
  const job = newCreativePortfolio({ ...portfolioRequest(), sourceAssets: [{ role: 'TRA_VIDEO', mediaId: video.locator.sourceVideoMediaId }],
    videoReview: { draftId: handoff.draftId, revision: handoff.revision }, reviewHandoff: handoff });
  job.snapshot = portfolioSnapshot(job); job.planning = { phase: 'READY_TO_RENDER' };
  job.snapshot.referenceCatalog = [referenceCandidate('6'), referenceCandidate('7')];
  job.snapshot.batchPlan.creatives.forEach((concept, index) => {
    concept.strategy.referenceSelection = { angleSource: null, layoutSource: job.snapshot!.referenceCatalog[index].referenceId, referenceRelationship: 'mixed' };
  });
  const pairs = frames.map((binding, index) => ({ slotIndex: index + 1, claimIndex: index,
    frameId: binding.frameId, attributionConfirmed: true }));
  return { job, pairs, segments, frames };
}
