import { describe, expect, expectTypeOf, it } from 'vitest';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import type { VideoFrameCandidatePolicy } from '@/lib/video/candidate-types';
import {
  MAX_VIDEO_INTELLIGENCE_PREPARATION_MANIFEST_BYTES,
  MAX_VIDEO_INTELLIGENCE_REPRESENTATIVE_BUNDLE_BYTES,
  createVideoIntelligenceAnalyzerFingerprint,
  validateVideoIntelligencePreparationManifest,
  type VideoIntelligencePreparationManifest,
} from '@/lib/video/intelligence-preparation';

const HASH = 'a'.repeat(64);
const technical = {
  version: 1 as const, analysisWidth: 144, analysisHeight: 256,
  differenceHash: '0123456789abcdef', meanRgb: [100, 101, 102] as [number, number, number],
  meanLuminance: 101, luminanceDeviation: 20, laplacianVariance: 100,
  darkFraction: 0.1, lightFraction: 0.1, qualityScore: 0.5,
};
const candidate = (candidateIndex: number, byteLength = candidateIndex + 10) => ({
  candidateIndex, timestampMs: candidateIndex * 100, sourceRole: 'TRA_VIDEO' as const,
  sourceVideoMediaId: 'media-video-1', sourceVideoFileName: 'source.mp4',
  sourceVideoContentHash: HASH, mimeType: 'image/jpeg' as const,
  width: 640, height: 360, byteLength, frameSha256: candidateIndex.toString(16).padStart(64, '0'),
  extractionReasons: ['INTERVAL'] as ['INTERVAL'], providerEligible: false as const, technical,
});
const manifest = (): VideoIntelligencePreparationManifest => ({
  version: 1, artifactType: 'VIDEO_INTELLIGENCE_PREPARATION', providerEligible: false,
  sourceVideoMediaId: 'media-video-1', sourceVideoFileName: 'source.mp4',
  sourceVideoContentHash: HASH, sourceVideoByteLength: 1_000_000,
  durationMs: 1_000, effectiveIntervalFps: 3,
  analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'gpt-5.6-terra'),
  candidates: [candidate(0), candidate(1), candidate(2)],
  groups: [
    { representativeIndex: 1, candidateIndexes: [0, 1] },
    { representativeIndex: 2, candidateIndexes: [2] },
  ],
  representativeBundle: {
    key: 'jobs/job-1/representatives.jpgbundle', sha256: 'c'.repeat(64), byteLength: 23,
    entries: [
      { candidateIndex: 1, offset: 0, byteLength: 11 },
      { candidateIndex: 2, offset: 11, byteLength: 12 },
    ],
  },
});
const clone = () => structuredClone(manifest());

describe('video intelligence preparation contract', () => {
  it('creates a stable analyzer fingerprint from every policy field and model', () => {
    expect(createVideoIntelligenceAnalyzerFingerprint(
      DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'gpt-5.6-terra'
    ).sha256).toBe('5a2a94df8782b076eee1c767254c93ec24acfc0210a73c6bc6ec68a45e3c3331');
    const base = createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'vision-a').sha256;
    const policyChanges: Array<Partial<VideoFrameCandidatePolicy>> = [
      { targetIntervalFps: 2 }, { maxIntervalCandidates: 359 }, { maxTotalCandidates: 479 },
      { maxWidth: 1279 }, { jpegQuality: 84 },
    ];
    for (const change of policyChanges) {
      expect(createVideoIntelligenceAnalyzerFingerprint(
        { ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, ...change }, 'vision-a'
      ).sha256).not.toBe(base);
    }
    expect(createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'vision-b').sha256).not.toBe(base);
    expect(() => createVideoIntelligenceAnalyzerFingerprint(
      { ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, imageFormat: 'png' } as unknown as VideoFrameCandidatePolicy,
      'vision-a'
    )).toThrow('JPEG');
    expect(() => createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, '  ')).toThrow('non-empty');
  });

  it('accepts the complete analysis-only manifest and preserves literal eligibility types', () => {
    const value = validateVideoIntelligencePreparationManifest(manifest());
    expect(value.providerEligible).toBe(false);
    expect(value.candidates.every((entry) => entry.providerEligible === false)).toBe(true);
    expectTypeOf(value.providerEligible).toEqualTypeOf<false>();
  });

  it.each([
    ['candidate order', (value: VideoIntelligencePreparationManifest) => { value.candidates[1].candidateIndex = 3; }],
    ['candidate source', (value: VideoIntelligencePreparationManifest) => { value.candidates[1].sourceVideoContentHash = 'd'.repeat(64); }],
    ['candidate timestamp', (value: VideoIntelligencePreparationManifest) => { value.candidates[1].timestampMs = 0; }],
    ['candidate dimensions', (value: VideoIntelligencePreparationManifest) => { value.candidates[1].width = 0; }],
    ['candidate eligibility', (value: VideoIntelligencePreparationManifest) => { (value.candidates[1] as { providerEligible: boolean }).providerEligible = true; }],
    ['candidate extraction', (value: VideoIntelligencePreparationManifest) => { value.candidates[1].extractionReasons = ['INTERVAL', 'INTERVAL']; }],
    ['technical metadata', (value: VideoIntelligencePreparationManifest) => { value.candidates[1].technical = { ...technical, qualityScore: Number.NaN }; }],
    ['analyzer digest drift', (value: VideoIntelligencePreparationManifest) => { value.analyzerFingerprint.sha256 = 'd'.repeat(64); }],
    ['analyzer policy drift', (value: VideoIntelligencePreparationManifest) => { value.analyzerFingerprint.candidatePolicy.jpegQuality = 84; }],
    ['vision model drift', (value: VideoIntelligencePreparationManifest) => { value.analyzerFingerprint.visionModel = 'other-model'; }],
    ['pipeline version drift', (value: VideoIntelligencePreparationManifest) => { (value.analyzerFingerprint as { pipelineVersion: string }).pipelineVersion = 'other'; }],
    ['transcription model drift', (value: VideoIntelligencePreparationManifest) => { (value.analyzerFingerprint as { transcriptionModel: string }).transcriptionModel = 'other'; }],
    ['effective FPS drift', (value: VideoIntelligencePreparationManifest) => { value.effectiveIntervalFps = 2; }],
    ['recorded candidate cap', (value: VideoIntelligencePreparationManifest) => { const policy = { ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, maxIntervalCandidates: 2, maxTotalCandidates: 2 }; value.analyzerFingerprint = createVideoIntelligenceAnalyzerFingerprint(policy, 'gpt-5.6-terra'); value.effectiveIntervalFps = 2; }],
    ['recorded width cap', (value: VideoIntelligencePreparationManifest) => { const policy = { ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, maxWidth: 639 }; value.analyzerFingerprint = createVideoIntelligenceAnalyzerFingerprint(policy, 'gpt-5.6-terra'); }],
    ['group coverage', (value: VideoIntelligencePreparationManifest) => { value.groups[1].candidateIndexes = []; }],
    ['group overlap', (value: VideoIntelligencePreparationManifest) => { value.groups[1].candidateIndexes = [1, 2]; }],
    ['nonmember representative', (value: VideoIntelligencePreparationManifest) => { value.groups[0].representativeIndex = 2; }],
    ['duplicate representative', (value: VideoIntelligencePreparationManifest) => { value.groups[1].representativeIndex = 1; value.groups[1].candidateIndexes = [1, 2]; }],
    ['missing bundle representative', (value: VideoIntelligencePreparationManifest) => { value.representativeBundle.entries.pop(); }],
    ['unsorted bundle representatives', (value: VideoIntelligencePreparationManifest) => { value.representativeBundle.entries.reverse(); }],
    ['bundle gap', (value: VideoIntelligencePreparationManifest) => { value.representativeBundle.entries[1].offset += 1; }],
    ['bundle entry length', (value: VideoIntelligencePreparationManifest) => { value.representativeBundle.entries[0].byteLength += 1; }],
    ['bundle final length', (value: VideoIntelligencePreparationManifest) => { value.representativeBundle.byteLength += 1; }],
    ['bundle hash', (value: VideoIntelligencePreparationManifest) => { value.representativeBundle.sha256 = 'invalid'; }],
  ] as const)('rejects invalid %s', (_label, mutate) => {
    const value = clone();
    mutate(value);
    expect(() => validateVideoIntelligencePreparationManifest(value)).toThrow('manifest rejected');
  });

  it('enforces source, bundle, and serialized-manifest byte limits', () => {
    const source = clone();
    source.sourceVideoByteLength = 25_000_001;
    expect(() => validateVideoIntelligencePreparationManifest(source)).toThrow('source');

    const bundle = clone();
    bundle.candidates[1].byteLength = MAX_VIDEO_INTELLIGENCE_REPRESENTATIVE_BUNDLE_BYTES + 1;
    bundle.representativeBundle.entries[0].byteLength = bundle.candidates[1].byteLength;
    bundle.representativeBundle.entries[1].offset = bundle.candidates[1].byteLength;
    bundle.representativeBundle.byteLength = bundle.candidates[1].byteLength + bundle.candidates[2].byteLength;
    expect(() => validateVideoIntelligencePreparationManifest(bundle)).toThrow('bundle length');

    const oversized = clone();
    oversized.representativeBundle.key = 'x'.repeat(MAX_VIDEO_INTELLIGENCE_PREPARATION_MANIFEST_BYTES);
    expect(() => validateVideoIntelligencePreparationManifest(oversized)).toThrow('2 MiB');
  });

  it('preserves all 480 candidates when every candidate is a representative', () => {
    const value = manifest();
    value.durationMs = 48_000;
    value.candidates = Array.from({ length: 480 }, (_, index) => candidate(index, 1));
    for (let index = 360; index < value.candidates.length; index += 1) value.candidates[index].extractionReasons = ['SCENE_CHANGE'];
    value.groups = value.candidates.map(({ candidateIndex }) => ({ representativeIndex: candidateIndex, candidateIndexes: [candidateIndex] }));
    value.representativeBundle.entries = value.candidates.map(({ candidateIndex }) => ({ candidateIndex, offset: candidateIndex, byteLength: 1 }));
    value.representativeBundle.byteLength = 480;
    expect(validateVideoIntelligencePreparationManifest(value).representativeBundle.entries).toHaveLength(480);
  });
});
