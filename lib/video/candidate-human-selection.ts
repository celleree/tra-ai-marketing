import { createHash } from 'node:crypto';
import { validateReviewFrame } from '@/lib/video/review-selection-sources';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { parseGenerateVideoFrameSelection, videoCandidateFrameId, type GenerateVideoFrameSelection,
  type VideoCandidateFrameBinding } from '@/lib/video/generation-selection-contract';
import { CANDIDATE_HUMAN_FRAME_SELECTION_POLICY, canonicalizeVideoFrameReuseContext,
  type VideoFrameReuseContext } from '@/lib/video/human-frame-selection';
import { loadVideoCandidateAnalysisImage, type VideoSelectionContext } from '@/lib/video/selection-context';
import { assessCandidateWithCache, isSuitableCandidate, readCandidateSuitability,
  type CandidateAssessmentDependencies, type CandidateAssessmentIdentity, type CandidateSuitabilityAssessment } from '@/lib/video/candidate-suitability';

export type CandidateSelectionSource = { source: HydratedTraVideoSource; context: VideoSelectionContext };
const MAX_RELEVANT_GROUPS = 6;
const MAX_REUSED_GROUPS = 1;
const MAX_CANDIDATES_PER_GROUP = 3;
type CandidateOption = { binding: VideoCandidateFrameBinding; source: CandidateSelectionSource;
  identity: CandidateAssessmentIdentity; useCount: number };
export type CandidateSelectionPlan = { status: 'COMPLETE'; selection: GenerateVideoFrameSelection }
  | { status: 'NO_SUITABLE_HUMAN' } | { status: 'CONTINUE' } | { status: 'BUSY' }
  | { status: 'RETRY_REQUIRED'; reason: 'LEASE_EXPIRED' | 'PROVIDER_FAILED' | 'INSUFFICIENT_TIME' }
  | { status: 'READY'; candidate: CandidateOption };
const words = (value: string) => new Set((value.toLowerCase().match(/[a-z]{4,20}/g) ?? [])
  .filter((word) => !['with', 'from', 'that', 'this', 'your', 'about', 'portfolio', 'video', 'selection',
    'creative', 'source', 'main', 'message', 'visual', 'desired', 'outcome'].includes(word)));
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

const candidateId = (sourceHash: string, candidate: { timestampMs: number; frameSha256: string }) =>
  videoCandidateFrameId(sourceHash, candidate.timestampMs, candidate.frameSha256);

const selectionFor = (candidate: CandidateOption, assessment: CandidateSuitabilityAssessment): GenerateVideoFrameSelection => {
  const { source, context } = candidate.source;
  const selection = parseGenerateVideoFrameSelection({ version: 3, libraryId: context.library.id,
    sourceVideoMediaId: source.media.id, sourceVideoContentHash: context.library.sourceVideoContentHash,
    librarySha256: context.librarySha256, frameIds: [candidate.binding.frameId],
    candidateBindings: [candidate.binding], sourceOverlays: [assessment.sourceOverlay] });
  if (!selection) throw new Error('Candidate selection cannot be persisted with exact provenance.');
  return selection;
};

/** B1 observations order the existing technical groups; only the next needed candidate is visually assessed. */
export const planCandidateHumanSelection = async (sources: readonly CandidateSelectionSource[], concept: string,
  reuseContext: VideoFrameReuseContext, model: string,
  dependencies: CandidateAssessmentDependencies): Promise<CandidateSelectionPlan> => {
  const reuse = canonicalizeVideoFrameReuseContext(reuseContext);
  const useCounts = new Map(reuse.frames.map((item) => [`${item.libraryId}\u0000${item.frameId}`, item.useCount]));
  if (!model.trim() || !concept.trim() || sources.length < 1 || sources.length > 10) {
    throw new Error('Candidate human selection input is invalid.');
  }
  const conceptWords = words(concept);
  const groups = sources.flatMap((source) => {
    const { library, manifest, librarySha256, preparationSha256 } = source.context;
    if (!manifest || !librarySha256 || !preparationSha256
      || manifest.sourceVideoMediaId !== source.source.media.id
      || manifest.sourceVideoContentHash !== library.sourceVideoContentHash
      || library.sourceVideoMediaId !== source.source.media.id
      || !/^[a-f0-9]{64}$/.test(librarySha256) || !/^[a-f0-9]{64}$/.test(preparationSha256)) {
      throw new Error('Candidate selection requires a frozen source-bound video preparation.');
    }
    return library.representativeFrames.map((representative) => {
      const candidate = library.candidates.find((item) => item.candidateIndex === representative.candidateIndex)!;
      const alternatives = representative.candidateIndexes.filter((index) => index !== representative.candidateIndex)
        .map((index) => library.candidates.find((item) => item.candidateIndex === index)!)
        .sort((a, b) => b.technical.qualityScore - a.technical.qualityScore || a.timestampMs - b.timestampMs)
        .slice(0, MAX_CANDIDATES_PER_GROUP - 1);
      const candidates = [candidate, ...alternatives].map((item) => {
        const frameId = candidateId(library.sourceVideoContentHash, item);
        return { source, binding: { frameId, representativeFrameId: representative.id,
          candidateIndex: item.candidateIndex, timestampMs: item.timestampMs, frameSha256: item.frameSha256 },
          identity: { policy: CANDIDATE_HUMAN_FRAME_SELECTION_POLICY, model,
            sourceVideoMediaId: library.sourceVideoMediaId, sourceVideoContentHash: library.sourceVideoContentHash,
            librarySha256, preparationSha256, representativeFrameId: representative.id,
            candidateIndex: item.candidateIndex, timestampMs: item.timestampMs, frameSha256: item.frameSha256 },
          useCount: useCounts.get(`${library.id}\u0000${frameId}`) ?? 0 };
      });
      const observation = representative.observation;
      const groupWords = words([observation.sceneType, ...observation.topics, observation.summary,
        observation.composition, ...observation.visibleText].join(' '));
      const relevance = [...conceptWords].filter((word) => groupWords.has(word)).length;
      return { source, representative, candidates, relevance,
        used: candidates.some((item) => item.useCount > 0) };
    });
  }).sort((a, b) => Number(a.used) - Number(b.used) || b.relevance - a.relevance
    || b.representative.qualityScore - a.representative.qualityScore
    || a.representative.timestampMs - b.representative.timestampMs
    || compareText(a.representative.id, b.representative.id));
  const narrowed = [
    ...groups.filter((group) => !group.used).slice(0, MAX_RELEVANT_GROUPS),
    ...groups.filter((group) => group.used).slice(0, MAX_REUSED_GROUPS),
  ];
  for (const group of narrowed) {
    let reusedSuitable: { candidate: CandidateOption; assessment: CandidateSuitabilityAssessment } | undefined;
    for (const candidate of group.candidates) {
      const state = await readCandidateSuitability(candidate.identity, dependencies);
      if (state.status === 'BUSY') return { status: 'BUSY' };
      if (state.status === 'RETRY_REQUIRED') return dependencies.retry ? { status: 'READY', candidate } : state;
      if (state.status === 'MISSING') return { status: 'READY', candidate };
      if (!isSuitableCandidate(state.assessment)) continue;
      if (candidate.useCount === 0) return { status: 'COMPLETE', selection: selectionFor(candidate, state.assessment) };
      reusedSuitable ??= { candidate, assessment: state.assessment };
    }
    if (reusedSuitable) return { status: 'COMPLETE', selection: selectionFor(reusedSuitable.candidate, reusedSuitable.assessment) };
  }
  return { status: 'NO_SUITABLE_HUMAN' };
};

/** One portfolio step performs at most one candidate visual call and checkpoints its reusable result. */
export const advanceCandidateHumanSelection = async (plan: Extract<CandidateSelectionPlan, { status: 'READY' }>,
  dependencies: CandidateAssessmentDependencies): Promise<Exclude<CandidateSelectionPlan, { status: 'READY' }>> => {
  const { candidate } = plan;
  const { source, context } = candidate.source;
  let bytes: Buffer;
  const representative = context.library.representativeFrames.find((frame) => frame.id === candidate.binding.representativeFrameId)!;
  if (candidate.binding.candidateIndex === representative.candidateIndex) {
    const image = context.representativeImages?.find((item) => item.frameId === representative.id);
    if (!image || image.candidateIndex !== candidate.binding.candidateIndex
      || image.timestampMs !== candidate.binding.timestampMs || image.frameSha256 !== candidate.binding.frameSha256
      || createHash('sha256').update(image.bytes).digest('hex') !== candidate.binding.frameSha256) {
      throw new Error('Frozen representative analysis image does not match its candidate.');
    }
    bytes = image.bytes;
  } else {
    bytes = (await loadVideoCandidateAnalysisImage(source, context, candidate.binding.candidateIndex)).bytes;
  }
  const result = await assessCandidateWithCache(candidate.identity, bytes, dependencies);
  if (result.status === 'RETRY_REQUIRED' || result.status === 'BUSY') return result;
  if (isSuitableCandidate(result.assessment) && candidate.useCount === 0) {
    return { status: 'COMPLETE', selection: selectionFor(candidate, result.assessment) };
  }
  return { status: 'CONTINUE' }; // Caller replans from the now-complete candidate cache.
};

/** Manual choices are a closed pool, including exact nonrepresentative candidates; never widen it. */
export const planManualCandidateHumanSelection = async (source: CandidateSelectionSource,
  bindings: readonly VideoCandidateFrameBinding[], model: string,
  dependencies: CandidateAssessmentDependencies): Promise<CandidateSelectionPlan> => {
  const { library, manifest, librarySha256, preparationSha256 } = source.context;
  if (!manifest || !librarySha256 || !preparationSha256 || !model.trim()
    || bindings.length < 1 || bindings.length > 3 || new Set(bindings.map(item => item.frameId)).size !== bindings.length) {
    throw new Error('Manual closed-pool selection requires exact frozen frame bindings and preparation.');
  }
  // Validate the entire pool before reading assessments or starting any provider work.
  bindings.forEach(binding => validateReviewFrame(binding, { library, manifest }));
  for (const binding of bindings) {
    const candidate: CandidateOption = { source, binding, useCount: 0, identity: {
      policy: CANDIDATE_HUMAN_FRAME_SELECTION_POLICY, model,
      sourceVideoMediaId: library.sourceVideoMediaId, sourceVideoContentHash: library.sourceVideoContentHash,
      librarySha256, preparationSha256, representativeFrameId: binding.representativeFrameId,
      candidateIndex: binding.candidateIndex, timestampMs: binding.timestampMs, frameSha256: binding.frameSha256,
    } };
    const state = await readCandidateSuitability(candidate.identity, dependencies);
    if (state.status === 'BUSY') return state;
    if (state.status === 'RETRY_REQUIRED') return dependencies.retry ? { status: 'READY', candidate } : state;
    if (state.status === 'MISSING') return { status: 'READY', candidate };
    if (isSuitableCandidate(state.assessment)) return { status: 'COMPLETE', selection: selectionFor(candidate, state.assessment) };
  }
  return { status: 'NO_SUITABLE_HUMAN' };
};
