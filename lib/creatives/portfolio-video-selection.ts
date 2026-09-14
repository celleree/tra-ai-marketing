import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import type { PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';
import { videoDependenciesFromPlanningSourceAnalysis } from '@/lib/creatives/video-intelligence-planning';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { parseGenerateVideoFrameSelection, type GenerateVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import { videoSourceHash } from '@/lib/video/library-service';
import { selectVideoFramesFromPoolWithCache, type VideoSelectionCacheDependencies } from '@/lib/video/selection-cache';
import { extractVideoSelectionFrames, loadSavedVideoSelectionContext, type VideoSelectionContext } from '@/lib/video/selection-context';

const MAX_CONCEPT_FIELD = 100;
const text = (value: unknown) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_CONCEPT_FIELD) : '';

type Restored = { source: HydratedTraVideoSource; context: VideoSelectionContext; librarySha256: string };
export type PortfolioVideoSelectionResult =
  | { status: 'BUSY' }
  | { status: 'RETRY_REQUIRED'; reason: 'LEASE_EXPIRED' | 'PROVIDER_FAILED' | 'INSUFFICIENT_TIME' }
  | { status: 'COMPLETE'; selection: GenerateVideoFrameSelection };

/** Canonical identity for frame choice. Caller supplies the final frozen planned concept. */
export function createPortfolioVideoSelectionConcept(concept: PlannedCreativeConcept) {
  const details = concept.strategy.conceptDetails;
  if (!details) throw new Error('Final creative concept is missing frame-selection details.');
  const value = {
    headline: text(concept.copy.headline), hook: text(concept.strategy.hook), mainMessage: text(details.mainMessage),
    proposition: text(details.proposition), visualMechanism: text(details.visualMechanism), subject: text(details.subject),
    environment: text(details.environment), painPoint: text(concept.strategy.painPoint), desiredOutcome: text(concept.strategy.desiredOutcome),
  };
  if (Object.values(value).some((entry) => !entry)) throw new Error('Final creative concept cannot produce a valid frame-selection identity.');
  const canonical = JSON.stringify(value);
  if (canonical.length > 2_000) throw new Error('Frame-selection concept exceeds its bounded identity limit.');
  return canonical;
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

export async function selectPortfolioVideoFrames(
  input: { sourceAnalysis: PlanningSourceAnalysisState; sources: readonly HydratedTraVideoSource[];
    finalConcept: PlannedCreativeConcept; cache: VideoSelectionCacheDependencies },
): Promise<PortfolioVideoSelectionResult> {
  const restored = await Promise.all(completedDependencies(input.sourceAnalysis).map((dependency) => restoreOne(input.sources, dependency)));
  const result = await selectVideoFramesFromPoolWithCache(restored.map(({ context, librarySha256 }) => ({ library: context.library, librarySha256 })),
    createPortfolioVideoSelectionConcept(input.finalConcept), input.cache);
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
  return extractVideoSelectionFrames(restored.source, restored.context, selection.frameIds);
}
