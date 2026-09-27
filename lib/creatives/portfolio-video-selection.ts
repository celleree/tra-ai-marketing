import { createHash } from 'node:crypto';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import type { PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';
import { videoDependenciesFromPlanningSourceAnalysis } from '@/lib/creatives/video-intelligence-planning';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { parseGenerateVideoFrameSelection, type GenerateVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import { videoSourceHash } from '@/lib/video/library-service';
import { preflightVideoHumanFrameFromPoolWithCache, selectVideoFramesFromPoolWithCache, selectVideoHumanFrameFromPoolWithCache,
  type VideoSelectionCacheDependencies } from '@/lib/video/selection-cache';
import { extractVideoSelectionFrames, loadSavedVideoSelectionContext, type VideoSelectionContext } from '@/lib/video/selection-context';
import { HUMAN_FRAME_SELECTION_POLICY, METADATA_FRAME_SELECTION_POLICY, createVideoFrameReuseContext,
  type AutomaticVideoSelectionPolicy, type VideoFrameReuseContext } from '@/lib/video/human-frame-selection';

const MAX_CONCEPT_EXCERPT = 160;
const normalizeText = (value: unknown) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
const excerpt = (value: string) => value.length <= MAX_CONCEPT_EXCERPT ? value
  : `${value.slice(0, MAX_CONCEPT_EXCERPT / 2)}…${value.slice(-(MAX_CONCEPT_EXCERPT / 2 - 1))}`;

type Restored = { source: HydratedTraVideoSource; context: VideoSelectionContext; librarySha256: string };
export type PortfolioVideoSelectionResult =
  | { status: 'BUSY' }
  | { status: 'RETRY_REQUIRED'; reason: 'LEASE_EXPIRED' | 'PROVIDER_FAILED' | 'INSUFFICIENT_TIME' }
  | { status: 'NO_SUITABLE_HUMAN' }
  | { status: 'COMPLETE'; selection: GenerateVideoFrameSelection };
export type PortfolioVideoSelectionPreflight = { status: 'READY' }
  | Extract<PortfolioVideoSelectionResult, { status: 'COMPLETE' | 'NO_SUITABLE_HUMAN' }>;

export const portfolioVideoSelectionPolicy = (concept: PlannedCreativeConcept): AutomaticVideoSelectionPolicy =>
  concept.strategy.execution?.subjectSource === 'approved-tra-human'
    ? HUMAN_FRAME_SELECTION_POLICY
    : METADATA_FRAME_SELECTION_POLICY;

export const portfolioVideoFrameReuseContext = (selections: readonly GenerateVideoFrameSelection[]): VideoFrameReuseContext =>
  createVideoFrameReuseContext(selections);

/** Canonical identity for frame choice. Caller supplies the final frozen planned concept. */
export function createPortfolioVideoSelectionConcept(concept: PlannedCreativeConcept) {
  const details = concept.strategy.conceptDetails;
  if (!details) throw new Error('Final creative concept is missing frame-selection details.');
  const full = {
    headline: normalizeText(concept.copy.headline), hook: normalizeText(concept.strategy.hook), mainMessage: normalizeText(details.mainMessage),
    proposition: normalizeText(details.proposition), visualMechanism: normalizeText(details.visualMechanism), subject: normalizeText(details.subject),
    environment: normalizeText(details.environment), painPoint: normalizeText(concept.strategy.painPoint), desiredOutcome: normalizeText(concept.strategy.desiredOutcome),
  };
  if (Object.values(full).some((entry) => !entry)) throw new Error('Final creative concept cannot produce a valid frame-selection identity.');
  const fullConceptSha256 = createHash('sha256').update(JSON.stringify(full)).digest('hex');
  const readable = Object.entries(full).map(([key, value]) => `${key}: ${excerpt(value)}`).join('\n');
  const bounded = `portfolio-video-selection:v2\nfullConceptSha256:${fullConceptSha256}\n${readable}`;
  if (bounded.length > 2_000) throw new Error('Frame-selection concept exceeds its bounded identity limit.');
  return bounded;
}

const completedDependencies = (sourceAnalysis: PlanningSourceAnalysisState) => {
  const dependencies = videoDependenciesFromPlanningSourceAnalysis(sourceAnalysis);
  if (dependencies.length < 1 || dependencies.length > 10) throw new Error('Video selection requires between 1 and 10 completed B1 video dependencies.');
  const libraryIds = dependencies.map((dependency) => dependency.completed!.library.id);
  const sourceIds = dependencies.map((dependency) => dependency.identity.sourceVideoMediaId);
  if (new Set(libraryIds).size !== libraryIds.length || new Set(sourceIds).size !== sourceIds.length) throw new Error('Completed B1 video dependencies have ambiguous source or library ownership.');
  return dependencies;
};

const sourceFor = (sources: readonly HydratedTraVideoSource[], mediaId: string, contentHash: string) => {
  const matches = sources.filter((source) => source.media.id === mediaId); const source = matches[0];
  if (matches.length !== 1 || !source || videoSourceHash(source) !== contentHash) throw new Error('Frozen B1 video dependency does not match exactly one hydrated source.');
  return source;
};

const restoreOne = async (
  sources: readonly HydratedTraVideoSource[], dependency: ReturnType<typeof completedDependencies>[number],
): Promise<Restored> => {
  const completed = dependency.completed!;
  const source = sourceFor(sources, dependency.identity.sourceVideoMediaId, dependency.identity.sourceVideoContentHash);
  const context = await loadSavedVideoSelectionContext(source, { identity: dependency.identity, artifact: completed.artifact });
  if (context.library.id !== completed.library.id || context.library.version !== completed.library.version
    || context.library.sourceVideoMediaId !== dependency.identity.sourceVideoMediaId
    || context.library.sourceVideoContentHash !== dependency.identity.sourceVideoContentHash) {
    throw new Error('Restored B1 video library does not match the frozen dependency.');
  }
  return { source, context, librarySha256: completed.artifact.sha256 };
};

const humanBindings = (restored: readonly Restored[]) => restored.map(({ context, librarySha256 }) => {
  if (!context.representativeImages) {
    throw new Error('Automatic human-frame selection requires source-bound preparation images; reanalyze the uploaded video.');
  }
  return { library: context.library, librarySha256, representativeImages: context.representativeImages };
});

const generationSelection = (outcome: Extract<import('@/lib/video/human-frame-selection').VideoHumanFrameSelectionOutcome, { status: 'SELECTED' }>) => {
  const selection = outcome.selection;
  const parsed = parseGenerateVideoFrameSelection({ version: 2, libraryId: selection.libraryId,
    sourceVideoContentHash: selection.sourceVideoContentHash, frameIds: selection.frames.map((frame) => frame.frameId),
    sourceOverlays: [outcome.selectedSourceOverlay] });
  if (!parsed) throw new Error('Cached visual human-frame selection cannot be persisted for generation.');
  return parsed;
};

/** Read-only check before portfolio selection quota. It neither claims cache work nor calls a provider. */
export async function preflightPortfolioVideoFrames(
  input: { sourceAnalysis: PlanningSourceAnalysisState; sources: readonly HydratedTraVideoSource[];
    finalConcept: PlannedCreativeConcept; selectionPolicy: AutomaticVideoSelectionPolicy;
    reuseContext: VideoFrameReuseContext; cache: VideoSelectionCacheDependencies },
): Promise<PortfolioVideoSelectionPreflight> {
  const expectedPolicy = portfolioVideoSelectionPolicy(input.finalConcept);
  if (input.selectionPolicy !== expectedPolicy) throw new Error('Frozen automatic video selection policy does not match the final concept.');
  if (input.selectionPolicy !== HUMAN_FRAME_SELECTION_POLICY) return { status: 'READY' };
  const restored = await Promise.all(completedDependencies(input.sourceAnalysis).map((dependency) => restoreOne(input.sources, dependency)));
  const result = await preflightVideoHumanFrameFromPoolWithCache(humanBindings(restored),
    createPortfolioVideoSelectionConcept(input.finalConcept), input.reuseContext, input.cache);
  if (result.status === 'READY') return result;
  if (result.outcome.status === 'NO_SUITABLE_HUMAN') return { status: 'NO_SUITABLE_HUMAN' };
  return { status: 'COMPLETE', selection: generationSelection(result.outcome) };
}

export async function selectPortfolioVideoFrames(
  input: { sourceAnalysis: PlanningSourceAnalysisState; sources: readonly HydratedTraVideoSource[];
    finalConcept: PlannedCreativeConcept; selectionPolicy?: AutomaticVideoSelectionPolicy;
    reuseContext?: VideoFrameReuseContext; cache: VideoSelectionCacheDependencies },
): Promise<PortfolioVideoSelectionResult> {
  const restored = await Promise.all(completedDependencies(input.sourceAnalysis).map((dependency) => restoreOne(input.sources, dependency)));
  const expectedPolicy = portfolioVideoSelectionPolicy(input.finalConcept);
  const selectionPolicy = input.selectionPolicy ?? expectedPolicy;
  const reuseContext = input.reuseContext ?? { version: 1 as const, frames: [] };
  if (selectionPolicy !== expectedPolicy) throw new Error('Frozen automatic video selection policy does not match the final concept.');
  const concept = createPortfolioVideoSelectionConcept(input.finalConcept);
  if (selectionPolicy === HUMAN_FRAME_SELECTION_POLICY) {
    const result = await selectVideoHumanFrameFromPoolWithCache(humanBindings(restored), concept, reuseContext, input.cache);
    if (result.status !== 'COMPLETE') return result;
    if (result.outcome.status === 'NO_SUITABLE_HUMAN') return { status: 'NO_SUITABLE_HUMAN' };
    return { status: 'COMPLETE', selection: generationSelection(result.outcome) };
  }
  const result = await selectVideoFramesFromPoolWithCache(restored.map(({ context, librarySha256 }) => ({ library: context.library, librarySha256 })),
    concept, input.cache);
  if (result.status !== 'COMPLETE') return result;
  const selection = parseGenerateVideoFrameSelection({ libraryId: result.selection.libraryId,
    sourceVideoContentHash: result.selection.sourceVideoContentHash, frameIds: result.selection.frames.map((frame) => frame.frameId) });
  if (!selection) throw new Error('Cached video selection cannot be persisted for generation.');
  return { status: 'COMPLETE', selection };
}

export async function hydratePortfolioVideoFrameSelection(
  input: { sourceAnalysis: PlanningSourceAnalysisState; sources: readonly HydratedTraVideoSource[]; selection: GenerateVideoFrameSelection },
) {
  const selection = parseGenerateVideoFrameSelection(input.selection);
  if (!selection) throw new Error('Persisted portfolio video frame selection is invalid.');
  const matches = completedDependencies(input.sourceAnalysis).filter((dependency) => dependency.completed!.library.id === selection.libraryId);
  if (matches.length !== 1) throw new Error('Persisted video selection has unknown or ambiguous frozen library ownership.');
  const dependency = matches[0];
  if (dependency.identity.sourceVideoContentHash !== selection.sourceVideoContentHash) throw new Error('Persisted video selection source content hash does not match the frozen B1 dependency.');
  const restored = await restoreOne(input.sources, dependency);
  const known = new Set(restored.context.library.representativeFrames.map((frame) => frame.id));
  if (selection.frameIds.some((frameId) => !known.has(frameId))) throw new Error('Persisted video selection contains an unknown frame ID.');
  if (selection.version !== 2 || !selection.sourceOverlays) {
    throw new Error('Saved human-frame selection predates source-overlay assessment. Retry this slot to reassess frames before rendering.');
  }
  const extracted = await extractVideoSelectionFrames(restored.source, restored.context, selection.frameIds);
  return { ...extracted, frames: extracted.frames.map((frame, index) => ({ ...frame, sourceOverlay: selection.sourceOverlays![index] })) };
}
