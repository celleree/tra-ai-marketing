import { describe, expect, expectTypeOf, it } from 'vitest';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import {
  DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
  HARD_MAX_INTERVAL_CANDIDATES,
  HARD_MAX_TOTAL_CANDIDATES,
  estimateIntervalCandidateCount,
  getEffectiveIntervalFps,
  validateVideoFrameCandidatePolicy,
} from '@/lib/video/candidate-policy';
import type {
  TemporaryVideoFrameCandidate,
  VideoFrameCandidateExtractionReason,
  VideoFrameCandidatePolicy,
} from '@/lib/video/candidate-types';

const makePolicy = (
  overrides: Partial<VideoFrameCandidatePolicy> = {}
): VideoFrameCandidatePolicy => ({
  ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY,
  ...overrides,
});

describe('video frame candidate policy', () => {
  it('uses the requested interval density for normal videos below the cap', () => {
    expect(getEffectiveIntervalFps(30_000)).toBe(3);
    expect(estimateIntervalCandidateCount(30_000)).toBe(90);
    expect(estimateIntervalCandidateCount(60_000)).toBe(180);
    expect(estimateIntervalCandidateCount(120_000)).toBe(360);
  });

  it('reduces the effective interval density for long videos instead of exceeding the cap', () => {
    expect(getEffectiveIntervalFps(300_000)).toBeCloseTo(1.2);
    expect(estimateIntervalCandidateCount(300_000)).toBe(360);
  });

  it('keeps very short valid videos bounded to at least one candidate', () => {
    expect(estimateIntervalCandidateCount(100)).toBe(1);
  });

  it('rejects invalid durations', () => {
    expect(() => getEffectiveIntervalFps(0)).toThrow('Video duration must be a positive number.');
    expect(() => getEffectiveIntervalFps(Number.NaN)).toThrow('Video duration must be a positive number.');
  });

  it('enforces non-overridable system candidate ceilings', () => {
    expect(HARD_MAX_INTERVAL_CANDIDATES).toBe(360);
    expect(HARD_MAX_TOTAL_CANDIDATES).toBe(480);

    expect(() =>
      validateVideoFrameCandidatePolicy(
        makePolicy({ maxIntervalCandidates: HARD_MAX_INTERVAL_CANDIDATES + 1 })
      )
    ).toThrow('hard system limit');

    expect(() =>
      validateVideoFrameCandidatePolicy(
        makePolicy({ maxTotalCandidates: HARD_MAX_TOTAL_CANDIDATES + 1 })
      )
    ).toThrow('hard system limit');
  });

  it.each([
    makePolicy({ targetIntervalFps: 0 }),
    makePolicy({ targetIntervalFps: Number.NaN }),
    makePolicy({ maxIntervalCandidates: 0 }),
    makePolicy({ maxIntervalCandidates: 1.5 }),
    makePolicy({ maxTotalCandidates: 0 }),
    makePolicy({ maxTotalCandidates: 100, maxIntervalCandidates: 101 }),
    makePolicy({ maxWidth: 0 }),
    makePolicy({ jpegQuality: 0 }),
    makePolicy({ jpegQuality: 101 }),
    makePolicy({ jpegQuality: 85.5 }),
  ])('rejects an invalid candidate policy', (policy) => {
    expect(() => validateVideoFrameCandidatePolicy(policy)).toThrow();
  });

  it('narrows candidate extraction inputs to hydrated MP4 video assets', () => {
    expectTypeOf<HydratedTraVideoSource['role']>().toEqualTypeOf<'TRA_VIDEO'>();
    expectTypeOf<HydratedTraVideoSource['media']['mediaType']>().toEqualTypeOf<'VIDEO'>();
    expectTypeOf<HydratedTraVideoSource['media']['mimeType']>().toEqualTypeOf<'video/mp4'>();
    expectTypeOf<HydratedTraVideoSource['stored']['mediaType']>().toEqualTypeOf<'VIDEO'>();
    expectTypeOf<HydratedTraVideoSource['stored']['mimeType']>().toEqualTypeOf<'video/mp4'>();
  });

  it('requires at least one extraction reason and allows combined provenance', () => {
    expectTypeOf<TemporaryVideoFrameCandidate['extractionReasons']>().toEqualTypeOf<
      readonly [VideoFrameCandidateExtractionReason, ...VideoFrameCandidateExtractionReason[]]
    >();

    const candidate: TemporaryVideoFrameCandidate = {
      candidateIndex: 12,
      timestampMs: 13_333,
      sourceRole: 'TRA_VIDEO',
      sourceVideoMediaId: `media_${'a'.repeat(32)}`,
      sourceVideoFileName: `media_${'a'.repeat(32)}.mp4`,
      sourceVideoContentHash: 'b'.repeat(64),
      mimeType: 'image/jpeg',
      width: 1280,
      height: 720,
      byteLength: 12345,
      frameSha256: 'c'.repeat(64),
      extractionReasons: ['INTERVAL', 'SCENE_CHANGE'],
      temporaryPath: '/tmp/tra-video/candidate-0012.jpg',
      lifecycle: 'TEMPORARY',
      providerEligible: false,
    };

    expect(candidate.extractionReasons).toEqual(['INTERVAL', 'SCENE_CHANGE']);
    expect(candidate.lifecycle).toBe('TEMPORARY');
    expect(candidate.providerEligible).toBe(false);
    expect('approvedHumanSource' in candidate).toBe(false);
    expect('cacheKey' in candidate).toBe(false);
  });
});
