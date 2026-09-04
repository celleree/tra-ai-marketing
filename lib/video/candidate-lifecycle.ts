import { cleanupTemporaryVideoFrameCandidateOwnership } from '@/lib/video/candidate-cleanup';
import { type HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { preprocessTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-preprocessor';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import type {
  TemporaryVideoFrameCandidateSet,
  VideoFrameCandidatePolicy,
} from '@/lib/video/candidate-types';

type TemporaryCandidateConsumer<T> = (
  candidateSet: TemporaryVideoFrameCandidateSet
) => T | Promise<T>;

type TemporaryCandidatePreprocessor = (
  source: HydratedTraVideoSource,
  policy: VideoFrameCandidatePolicy
) => Promise<TemporaryVideoFrameCandidateSet>;

type TemporaryCandidateCleanup = typeof cleanupTemporaryVideoFrameCandidateOwnership;

interface TemporaryCandidateLifecycleDependencies {
  preprocessCandidates?: TemporaryCandidatePreprocessor;
  cleanupCandidateOwnership?: TemporaryCandidateCleanup;
}

const preprocessCandidatesByDefault: TemporaryCandidatePreprocessor = (source, policy) =>
  preprocessTemporaryTraVideoFrameCandidates(source, {}, policy);

export const withTemporaryTraVideoFrameCandidates = async <T>(
  source: HydratedTraVideoSource,
  consumer: TemporaryCandidateConsumer<T>,
  dependencies: TemporaryCandidateLifecycleDependencies = {},
  policy: VideoFrameCandidatePolicy = DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY
): Promise<T> => {
  const preprocessCandidates =
    dependencies.preprocessCandidates || preprocessCandidatesByDefault;
  const cleanupCandidateOwnership =
    dependencies.cleanupCandidateOwnership || cleanupTemporaryVideoFrameCandidateOwnership;
  const candidateSet = await preprocessCandidates(source, policy);
  const cleanupOwnership: TemporaryVideoFrameCandidateSet = {
    ...candidateSet,
    temporaryDirectories: [...candidateSet.temporaryDirectories],
  };

  let result: T;
  try {
    result = await consumer(candidateSet);
  } catch (consumerError) {
    try {
      await cleanupCandidateOwnership(cleanupOwnership);
    } catch (cleanupError) {
      console.error(
        'Failed to clean temporary video candidate ownership after consumer error.',
        cleanupError
      );
    }
    throw consumerError;
  }

  await cleanupCandidateOwnership(cleanupOwnership);
  return result;
};
