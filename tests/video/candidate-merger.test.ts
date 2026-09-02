import { describe, expect, it } from 'vitest';
import { mergeTemporaryVideoFrameCandidates } from '@/lib/video/candidate-merger';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import type {
  TemporaryVideoFrameCandidate,
  TemporaryVideoFrameCandidateSet,
} from '@/lib/video/candidate-types';

const sourceVideoMediaId = 'media-video-1';
const sourceVideoContentHash = 'video-sha-256';

const candidate = (
  timestampMs: number,
  extractionReasons: TemporaryVideoFrameCandidate['extractionReasons'] = ['INTERVAL'],
  overrides: Partial<TemporaryVideoFrameCandidate> = {}
): TemporaryVideoFrameCandidate => ({
  candidateIndex: 99,
  timestampMs,
  sourceRole: 'TRA_VIDEO',
  sourceVideoMediaId,
  sourceVideoFileName: 'source.mp4',
  sourceVideoContentHash,
  mimeType: 'image/jpeg',
  width: 640,
  height: 360,
  byteLength: 1_234,
  frameSha256: `frame-${timestampMs}`,
  extractionReasons,
  temporaryPath: `/tmp/candidate-${timestampMs}.jpg`,
  lifecycle: 'TEMPORARY',
  providerEligible: false,
  ...overrides,
});

const candidateSet = (
  candidates: TemporaryVideoFrameCandidate[],
  maxTotalCandidates = 4
): TemporaryVideoFrameCandidateSet => ({
  sourceVideoMediaId,
  sourceVideoFileName: 'source.mp4',
  sourceVideoContentHash,
  durationMs: 4_000,
  policy: {
    ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
    maxIntervalCandidates: maxTotalCandidates,
    maxTotalCandidates,
  },
  effectiveIntervalFps: 3,
  candidates,
  temporaryDirectory: '/tmp/candidates',
});

describe('temporary video frame candidate merger', () => {
  it('keeps interval candidates when no scene candidates are supplied', () => {
    const interval = candidate(2_000);
    const result = mergeTemporaryVideoFrameCandidates(candidateSet([interval]), []);

    expect(result.candidates).toEqual([{ ...interval, candidateIndex: 0 }]);
  });

  it('inserts and orders scene candidates chronologically, then reindexes the output pool', () => {
    const result = mergeTemporaryVideoFrameCandidates(
      candidateSet([candidate(3_000), candidate(1_000)]),
      [candidate(2_000, ['SCENE_CHANGE']), candidate(4_000, ['SCENE_CHANGE'])]
    );

    expect(result.candidates.map(({ timestampMs, candidateIndex }) => [timestampMs, candidateIndex]))
      .toEqual([[1_000, 0], [2_000, 1], [3_000, 2], [4_000, 3]]);
  });

  it('merges exact timestamp collisions with both reasons and retains the interval candidate bytes', () => {
    const interval = candidate(1_000, ['INTERVAL'], {
      frameSha256: 'interval-frame-sha',
      width: 720,
      height: 405,
      byteLength: 9_876,
      temporaryPath: '/tmp/interval.jpg',
    });
    const scene = candidate(1_000, ['SCENE_CHANGE'], {
      frameSha256: 'scene-frame-sha',
      temporaryPath: '/tmp/scene.jpg',
    });

    const [result] = mergeTemporaryVideoFrameCandidates(candidateSet([interval]), [scene]).candidates;

    expect(result).toMatchObject({
      ...interval,
      candidateIndex: 0,
      extractionReasons: ['INTERVAL', 'SCENE_CHANGE'],
      lifecycle: 'TEMPORARY',
      providerEligible: false,
    });
  });

  it('keeps near timestamps as distinct candidates', () => {
    const result = mergeTemporaryVideoFrameCandidates(
      candidateSet([candidate(1_000)]),
      [candidate(1_001, ['SCENE_CHANGE'])]
    );

    expect(result.candidates.map((frame) => frame.timestampMs)).toEqual([1_000, 1_001]);
  });

  it.each([
    ['sourceVideoMediaId', { sourceVideoMediaId: 'other-media' }],
    ['sourceVideoContentHash', { sourceVideoContentHash: 'other-hash' }],
  ])('fails closed for mismatched %s', (field, overrides) => {
    expect(() =>
      mergeTemporaryVideoFrameCandidates(
        candidateSet([candidate(1_000)]),
        [candidate(2_000, ['SCENE_CHANGE'], overrides)]
      )
    ).toThrow(field);
  });

  it('accepts exactly maxTotalCandidates and rejects a larger unique pool', () => {
    const fourCandidates = [candidate(1_000), candidate(2_000), candidate(3_000), candidate(4_000)];
    expect(mergeTemporaryVideoFrameCandidates(candidateSet(fourCandidates, 4), []).candidates)
      .toHaveLength(4);

    expect(() =>
      mergeTemporaryVideoFrameCandidates(
        candidateSet(fourCandidates.slice(0, 3), 3),
        [candidate(4_000, ['SCENE_CHANGE'])]
      )
    ).toThrow('maxTotalCandidates');
  });
});
