import type {
  NonEmptyVideoFrameCandidateExtractionReasons,
  TemporaryVideoFrameCandidate,
  TemporaryVideoFrameCandidateSet,
} from '@/lib/video/candidate-types';

const validateCandidateSource = (
  candidate: TemporaryVideoFrameCandidate,
  intervalCandidates: TemporaryVideoFrameCandidateSet
) => {
  if (candidate.sourceVideoMediaId !== intervalCandidates.sourceVideoMediaId) {
    throw new Error('Cannot merge candidates with a different sourceVideoMediaId.');
  }
  if (
    candidate.sourceVideoContentHash !==
    intervalCandidates.sourceVideoContentHash
  ) {
    throw new Error('Cannot merge candidates with a different sourceVideoContentHash.');
  }
};

const mergeExtractionReasons = (
  first: TemporaryVideoFrameCandidate,
  second: TemporaryVideoFrameCandidate
): NonEmptyVideoFrameCandidateExtractionReasons => {
  const extractionReasons: NonEmptyVideoFrameCandidateExtractionReasons = [
    first.extractionReasons[0],
    ...[...new Set([...first.extractionReasons, ...second.extractionReasons])]
      .filter((reason) => reason !== first.extractionReasons[0]),
  ];
  return extractionReasons;
};

export const mergeTemporaryVideoFrameCandidates = (
  intervalCandidates: TemporaryVideoFrameCandidateSet,
  sceneCandidates: readonly TemporaryVideoFrameCandidate[]
): TemporaryVideoFrameCandidateSet => {
  const candidatesByTimestamp = new Map<number, TemporaryVideoFrameCandidate>();

  for (const candidate of intervalCandidates.candidates) {
    validateCandidateSource(candidate, intervalCandidates);
    const existing = candidatesByTimestamp.get(candidate.timestampMs);
    candidatesByTimestamp.set(
      candidate.timestampMs,
      existing
        ? {
            ...existing,
            extractionReasons: mergeExtractionReasons(existing, candidate),
          }
        : candidate
    );
  }

  for (const candidate of sceneCandidates) {
    validateCandidateSource(candidate, intervalCandidates);
    const existing = candidatesByTimestamp.get(candidate.timestampMs);
    candidatesByTimestamp.set(
      candidate.timestampMs,
      existing
        ? {
            ...existing,
            extractionReasons: mergeExtractionReasons(existing, candidate),
          }
        : candidate
    );
  }

  const candidates = [...candidatesByTimestamp.values()]
    .sort((first, second) => first.timestampMs - second.timestampMs)
    .map((candidate, candidateIndex) => ({ ...candidate, candidateIndex }));

  if (candidates.length > intervalCandidates.policy.maxTotalCandidates) {
    throw new Error('Merged candidates exceed policy.maxTotalCandidates.');
  }

  return { ...intervalCandidates, candidates };
};
