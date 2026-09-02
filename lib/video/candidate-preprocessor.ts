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

interface TraVideoCandidatePreprocessorDependencies {
  extractor?: TraVideoCandidateExtractor;
  sceneChangeDetector?: SceneChangeDetector;
  sceneCandidateMaterializer?: TraVideoSceneCandidateMaterializer;
}

export const preprocessTemporaryTraVideoFrameCandidates = async (
  source: HydratedTraVideoSource,
  dependencies: TraVideoCandidatePreprocessorDependencies = {},
  policy: VideoFrameCandidatePolicy = DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY
): Promise<TemporaryVideoFrameCandidateSet> => {
  const extractor = dependencies.extractor || new FfmpegIntervalCandidateExtractor();
  const intervalCandidates = await extractor.extractCandidates(source, policy);
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
  const mergedCandidates = mergeTemporaryVideoFrameCandidates(
    intervalCandidates,
    sceneMaterialization.candidates
  );
  if (!sceneMaterialization.temporaryDirectory) {
    throw new Error('Scene candidate materialization did not return a temporary directory.');
  }

  return {
    ...mergedCandidates,
    temporaryDirectories: [
      ...intervalCandidates.temporaryDirectories,
      sceneMaterialization.temporaryDirectory,
    ],
  };
};
