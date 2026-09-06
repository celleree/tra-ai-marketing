import { describe, expect, it } from 'vitest';
import { groupSimilarVideoCandidates } from '@/lib/video/candidate-technical-selection';
import type { FrameTechnicalAnalysis } from '@/lib/video/frame-technical-analysis';

const metrics: FrameTechnicalAnalysis = {
  version: 1, differenceHash: '0000000000000000', meanRgb: [100, 100, 100],
  meanLuminance: 100, luminanceDeviation: 20, laplacianVariance: 100,
  darkFraction: 0, lightFraction: 0, qualityScore: 0.5,
};
const candidate = (candidateIndex: number, technical: Partial<FrameTechnicalAnalysis> = {}) => ({
  candidateIndex, frameSha256: String(candidateIndex).padStart(64, '0'), width: 360, height: 640,
  extractionReasons: ['INTERVAL'] as ['INTERVAL' | 'SCENE_CHANGE'],
  technical: { ...metrics, ...technical },
});

describe('candidate duplicate groups', () => {
  it('retains all similar members and selects the best technical representative', () => {
    expect(groupSimilarVideoCandidates([
      candidate(0), candidate(1, { qualityScore: 0.8, differenceHash: '0000000000000001' }),
      candidate(2, { differenceHash: 'ffffffffffffffff' }),
    ])).toEqual([
      { representativeIndex: 1, candidateIndexes: [0, 1] },
      { representativeIndex: 2, candidateIndexes: [2] },
    ]);
  });

  it('preserves scene boundaries even for identical image bytes and equal scores', () => {
    const first = candidate(0);
    const next = { ...candidate(1), frameSha256: first.frameSha256 };
    const scene = { ...candidate(2), frameSha256: first.frameSha256, extractionReasons: ['SCENE_CHANGE'] as ['SCENE_CHANGE'] };
    expect(groupSimilarVideoCandidates([first, next, scene, candidate(3)])).toEqual([
      { representativeIndex: 0, candidateIndexes: [0, 1] },
      { representativeIndex: 2, candidateIndexes: [2, 3] },
    ]);
  });

  it('does not collapse differing colour, contrast, or geometry despite hash collisions', () => {
    const differentColour = candidate(1, { meanRgb: [200, 20, 20] });
    const differentContrast = candidate(2, { luminanceDeviation: 50 });
    const landscape = { ...candidate(3), width: 640, height: 360 };
    expect(groupSimilarVideoCandidates([candidate(0), differentColour, differentContrast, landscape])).toHaveLength(4);
  });

  it('avoids transitive similarity drift through intermediate representatives', () => {
    const result = groupSimilarVideoCandidates([
      candidate(0), candidate(1, { meanRgb: [110, 110, 110], qualityScore: 0.9 }),
      candidate(2, { meanRgb: [120, 120, 120] }),
    ]);
    expect(result.map((group) => group.candidateIndexes)).toEqual([[0, 1], [2]]);
    expect(groupSimilarVideoCandidates([])).toEqual([]);
  });
});
