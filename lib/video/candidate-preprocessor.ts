import path from 'node:path';
import { cleanupTemporaryVideoFrameCandidateOwnership } from '@/lib/video/candidate-cleanup';
import {
  FfmpegIntervalCandidateExtractor,
  FfmpegSceneCandidateMaterializer,
  type HydratedTraVideoSource,
  type TraVideoCandidateExtractor,
  type TraVideoSceneCandidateMaterializer,
} from '@/lib/video/candidate-extractor';
import { mergeTemporaryVideoFrameCandidates } from '@/lib/video/candidate-merger';
import {
  DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
} from '@/lib/video/candidate-policy';
import type {
  TemporaryVideoFrameCandidateSet,
  VideoFrameCandidatePolicy,
} from '@/lib/video/candidate-types';
import {
  FfmpegSceneChangeDetector,
  type SceneChangeDetector,
} from '@/lib/video/scene-change-detector';

type TraVideoCandidateCleanup = typeof cleanupTemporaryVideoFrameCandidateOwnership;

interface TraVideoCandidatePreprocessorDependencies {
  extractor?: TraVideoCandidateExtractor;
  sceneChangeDetector?: SceneChangeDetector;
  sceneCandidateMaterializer?: TraVideoSceneCandidateMaterializer;
  cleanupCandidateOwnership?: TraVideoCandidateCleanup;
}

const candidateReferencesDirectory = (
  candidateSet: TemporaryVideoFrameCandidateSet,
  directory: string
) => {
  const resolvedDirectory = path.resolve(directory);
  return candidateSet.candidates.some(
    (candidate) =>
      path.resolve(path.dirname(candidate.temporaryPath)) === resolvedDirectory
  );
};

export const preprocessTemporaryTraVideoFrameCandidates = async (
  source: HydratedTraVideoSource,
  dependencies: TraVideoCandidatePreprocessorDependencies = {},
  policy: VideoFrameCandidatePolicy = DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY
): Promise<TemporaryVideoFrameCandidateSet> => {
  const extractor = dependencies.extractor || new FfmpegIntervalCandidateExtractor();
  const cleanupCandidateOwnership =
    dependencies.cleanupCandidateOwnership || cleanupTemporaryVideoFrameCandidateOwnership;
  const intervalCandidates = await extractor.extractCandidates(source, policy);
  let cleanupOwnership = intervalCandidates;

  try {
    const remainingSceneBudget =
      intervalCandidates.policy.maxTotalCandidates - intervalCandidates.candidates.length;

    if (remainingSceneBudget <= 0) {
      return mergeTemporaryVideoFrameCandidates(intervalCandidates, []);
    }

    const sceneChangeDetector =
      dependencies.sceneChangeDetector || new FfmpegSceneChangeDetector();
    const sceneTimestampsMs = await sceneChangeDetector.detect(
      intervalCandidates.temporarySourceVideoPath,
      intervalCandidates.durationMs,
      remainingSceneBudget
    );

    if (!sceneTimestampsMs.length) {
      return mergeTemporaryVideoFrameCandidates(intervalCandidates, []);
    }

    const sceneCandidateMaterializer =
      dependencies.sceneCandidateMaterializer || new FfmpegSceneCandidateMaterializer();
    const sceneMaterialization = await sceneCandidateMaterializer.materializeCandidates(
      source,
      sceneTimestampsMs,
      intervalCandidates.policy
    );
    if (!sceneMaterialization.temporaryDirectory) {
      throw new Error('Scene candidate materialization did not return a temporary directory.');
    }

    cleanupOwnership = {
      ...intervalCandidates,
      temporaryDirectories: [
        ...intervalCandidates.temporaryDirectories,
        sceneMaterialization.temporaryDirectory,
      ],
    };
    const mergedCandidates = mergeTemporaryVideoFrameCandidates(
      intervalCandidates,
      sceneMaterialization.candidates
    );

    if (
      !candidateReferencesDirectory(
        mergedCandidates,
        sceneMaterialization.temporaryDirectory
      )
    ) {
      const unreferencedSceneOwnership = {
        ...intervalCandidates,
        temporaryDirectories: [sceneMaterialization.temporaryDirectory],
      };
      cleanupOwnership = intervalCandidates;
      await cleanupCandidateOwnership(unreferencedSceneOwnership);
      return {
        ...mergedCandidates,
        temporaryDirectories: intervalCandidates.temporaryDirectories,
      };
    }

    return {
      ...mergedCandidates,
      temporaryDirectories: cleanupOwnership.temporaryDirectories,
    };
  } catch (error) {
    try {
      await cleanupCandidateOwnership(cleanupOwnership);
    } catch (cleanupError) {
      console.error(
        'Failed to clean temporary video candidate ownership after preprocessing error.',
        cleanupError
      );
    }
    throw error;
  }
};
