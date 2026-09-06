import { readFile } from 'node:fs/promises';
import type { TemporaryVideoFrameCandidate, TemporaryVideoFrameCandidateSet } from '@/lib/video/candidate-types';
import { analyzeFrameTechnicalQuality, type FrameTechnicalAnalysis } from '@/lib/video/frame-technical-analysis';

export interface CandidateDuplicateGroup {
  representativeIndex: number;
  candidateIndexes: number[];
}

type ComparableCandidate = Pick<TemporaryVideoFrameCandidate,
  'candidateIndex' | 'frameSha256' | 'width' | 'height' | 'extractionReasons'> & {
    technical: FrameTechnicalAnalysis;
  };

const hashDistance = (first: string, second: string) => {
  let count = 0;
  for (let i = 0; i < first.length; i += 2) {
    let bits = Number.parseInt(first.slice(i, i + 2), 16) ^ Number.parseInt(second.slice(i, i + 2), 16);
    while (bits) { count += bits & 1; bits >>>= 1; }
  }
  return count;
};

const similar = (first: ComparableCandidate, second: ComparableCandidate) => {
  if (first.frameSha256 === second.frameSha256) return true;
  const a = first.technical;
  const b = second.technical;
  return Math.abs(first.width / first.height - second.width / second.height) < 0.01
    && hashDistance(a.differenceHash, b.differenceHash) <= 4
    && a.meanRgb.every((value, channel) => Math.abs(value - b.meanRgb[channel]) <= 12)
    && Math.abs(a.luminanceDeviation - b.luminanceDeviation) <= 12;
};

// Input order comes from the validated chronological candidate lifecycle.
// Preserve every member and compare to a fixed anchor to avoid transitive drift.
export const groupSimilarVideoCandidates = (candidates: readonly ComparableCandidate[]): CandidateDuplicateGroup[] => {
  const groups: Array<CandidateDuplicateGroup & { anchor: ComparableCandidate; best: ComparableCandidate }> = [];
  let sceneStart = 0;
  for (const candidate of candidates) {
    if (candidate.extractionReasons.includes('SCENE_CHANGE')) sceneStart = groups.length;
    const match = groups.slice(sceneStart).find((group) => similar(group.anchor, candidate));
    if (match) {
      match.candidateIndexes.push(candidate.candidateIndex);
      if (candidate.technical.qualityScore > match.best.technical.qualityScore) {
        match.best = candidate;
        match.representativeIndex = candidate.candidateIndex;
      }
    } else {
      groups.push({ anchor: candidate, best: candidate,
        representativeIndex: candidate.candidateIndex, candidateIndexes: [candidate.candidateIndex] });
    }
  }
  return groups.map(({ representativeIndex, candidateIndexes }) => ({ representativeIndex, candidateIndexes }));
};

// Run only inside withTemporaryTraVideoFrameCandidates's validated consumer.
// The returned metadata survives cleanup but grants no provider eligibility.
export const analyzeTemporaryVideoCandidates = async (set: TemporaryVideoFrameCandidateSet) => {
  const analyzed: ComparableCandidate[] = [];
  for (const candidate of set.candidates) {
    analyzed.push({ ...candidate, technical: await analyzeFrameTechnicalQuality(await readFile(candidate.temporaryPath)) });
  }
  return {
    version: 1 as const,
    sourceVideoMediaId: set.sourceVideoMediaId,
    sourceVideoContentHash: set.sourceVideoContentHash,
    providerEligible: false as const,
    candidates: analyzed.map(({ candidateIndex, frameSha256, technical }) => ({ candidateIndex, frameSha256, technical })),
    groups: groupSimilarVideoCandidates(analyzed),
  };
};
