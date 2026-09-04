import { createHash } from 'node:crypto';
import path from 'node:path';
import { cleanupTemporaryVideoFrameCandidateOwnership } from '@/lib/video/candidate-cleanup';
import { type HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { preprocessTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-preprocessor';
import {
  DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
  getEffectiveIntervalFps,
  validateVideoFrameCandidatePolicy,
} from '@/lib/video/candidate-policy';
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

const rejectBoundary = (reason: string): never => {
  throw new Error(`Temporary video candidate boundary rejected: ${reason}`);
};

const policiesMatch = (
  actual: VideoFrameCandidatePolicy,
  requested: VideoFrameCandidatePolicy
) =>
  actual.targetIntervalFps === requested.targetIntervalFps &&
  actual.maxIntervalCandidates === requested.maxIntervalCandidates &&
  actual.maxTotalCandidates === requested.maxTotalCandidates &&
  actual.maxWidth === requested.maxWidth &&
  actual.imageFormat === requested.imageFormat &&
  actual.jpegQuality === requested.jpegQuality;

const isOwnedTemporaryFile = (
  filePath: string,
  temporaryDirectories: readonly string[]
) => {
  const resolvedFilePath = path.resolve(filePath);
  return temporaryDirectories.some((directory) => {
    const resolvedDirectory = path.resolve(directory);
    const relative = path.relative(resolvedDirectory, resolvedFilePath);
    return (
      relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  });
};

const assertTemporaryCandidateBoundary = (
  source: HydratedTraVideoSource,
  candidateSet: TemporaryVideoFrameCandidateSet,
  requestedPolicy: VideoFrameCandidatePolicy
) => {
  validateVideoFrameCandidatePolicy(requestedPolicy);
  validateVideoFrameCandidatePolicy(candidateSet.policy);
  if (!policiesMatch(candidateSet.policy, requestedPolicy)) {
    rejectBoundary('candidate-set policy does not match the requested policy.');
  }

  const expectedContentHash = createHash('sha256')
    .update(source.stored.buffer)
    .digest('hex');
  if (
    candidateSet.sourceVideoMediaId !== source.media.id ||
    candidateSet.sourceVideoFileName !== source.media.fileName ||
    candidateSet.sourceVideoContentHash !== expectedContentHash
  ) {
    rejectBoundary('candidate-set source provenance does not match the hydrated TRA video.');
  }
  if (!Number.isFinite(candidateSet.durationMs) || candidateSet.durationMs <= 0) {
    rejectBoundary('durationMs must be positive.');
  }
  const expectedEffectiveIntervalFps = getEffectiveIntervalFps(
    candidateSet.durationMs,
    requestedPolicy
  );
  if (
    !Number.isFinite(candidateSet.effectiveIntervalFps) ||
    candidateSet.effectiveIntervalFps !== expectedEffectiveIntervalFps
  ) {
    rejectBoundary('effectiveIntervalFps does not match the requested policy and duration.');
  }
  if (
    candidateSet.candidates.length < 1 ||
    candidateSet.candidates.length > requestedPolicy.maxTotalCandidates
  ) {
    rejectBoundary('candidate count is outside the requested bounded policy.');
  }
  if (
    candidateSet.temporaryDirectories.length < 1 ||
    candidateSet.temporaryDirectories.some((directory) => !directory) ||
    !isOwnedTemporaryFile(
      candidateSet.temporarySourceVideoPath,
      candidateSet.temporaryDirectories
    )
  ) {
    rejectBoundary('temporary source ownership is invalid.');
  }

  let previousTimestampMs = -1;
  let intervalCandidateCount = 0;
  for (let index = 0; index < candidateSet.candidates.length; index += 1) {
    const candidate = candidateSet.candidates[index];
    if (
      candidate.candidateIndex !== index ||
      !Number.isFinite(candidate.timestampMs) ||
      candidate.timestampMs < 0 ||
      candidate.timestampMs >= candidateSet.durationMs ||
      candidate.timestampMs <= previousTimestampMs
    ) {
      rejectBoundary('candidate ordering or timestamp metadata is invalid.');
    }
    if (
      candidate.sourceRole !== 'TRA_VIDEO' ||
      candidate.sourceVideoMediaId !== candidateSet.sourceVideoMediaId ||
      candidate.sourceVideoFileName !== candidateSet.sourceVideoFileName ||
      candidate.sourceVideoContentHash !== candidateSet.sourceVideoContentHash
    ) {
      rejectBoundary('candidate source provenance is inconsistent.');
    }
    if (
      candidate.mimeType !== 'image/jpeg' ||
      candidate.lifecycle !== 'TEMPORARY' ||
      candidate.providerEligible !== false ||
      'approvedHumanSource' in candidate ||
      'cacheKey' in candidate
    ) {
      rejectBoundary('candidate crossed the temporary/approved-frame boundary.');
    }
    if (
      !Number.isInteger(candidate.width) ||
      candidate.width < 1 ||
      candidate.width > requestedPolicy.maxWidth ||
      !Number.isInteger(candidate.height) ||
      candidate.height < 1 ||
      !Number.isInteger(candidate.byteLength) ||
      candidate.byteLength < 1 ||
      !/^[a-f0-9]{64}$/.test(candidate.frameSha256)
    ) {
      rejectBoundary('candidate integrity metadata is invalid.');
    }
    if (
      !Array.isArray(candidate.extractionReasons) ||
      candidate.extractionReasons.length < 1 ||
      candidate.extractionReasons.some(
        (reason) => reason !== 'INTERVAL' && reason !== 'SCENE_CHANGE'
      ) ||
      new Set(candidate.extractionReasons).size !== candidate.extractionReasons.length
    ) {
      rejectBoundary('candidate extraction provenance is invalid.');
    }
    if (candidate.extractionReasons.includes('INTERVAL')) {
      intervalCandidateCount += 1;
    }
    if (!isOwnedTemporaryFile(candidate.temporaryPath, candidateSet.temporaryDirectories)) {
      rejectBoundary('candidate file is outside preprocessing-owned temporary directories.');
    }
    previousTimestampMs = candidate.timestampMs;
  }

  if (
    intervalCandidateCount < 1 ||
    intervalCandidateCount > requestedPolicy.maxIntervalCandidates
  ) {
    rejectBoundary('interval candidate count is outside the requested bounded policy.');
  }
};

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
  const requestedPolicy = { ...policy };
  validateVideoFrameCandidatePolicy(requestedPolicy);
  const candidateSet = await preprocessCandidates(source, { ...requestedPolicy });
  const cleanupOwnership: TemporaryVideoFrameCandidateSet = {
    ...candidateSet,
    temporaryDirectories: [...candidateSet.temporaryDirectories],
  };

  let result: T;
  try {
    assertTemporaryCandidateBoundary(source, candidateSet, requestedPolicy);
    result = await consumer(candidateSet);
  } catch (lifecycleError) {
    try {
      await cleanupCandidateOwnership(cleanupOwnership);
    } catch (cleanupError) {
      console.error(
        'Failed to clean temporary video candidate ownership after lifecycle error.',
        cleanupError
      );
    }
    throw lifecycleError;
  }

  await cleanupCandidateOwnership(cleanupOwnership);
  return result;
};
