import { createHash } from 'node:crypto';
import {
  HARD_MAX_TOTAL_CANDIDATES,
  getEffectiveIntervalFps,
  validateVideoFrameCandidatePolicy,
} from '@/lib/video/candidate-policy';
import type {
  TemporaryVideoFrameCandidate,
  VideoFrameCandidatePolicy,
} from '@/lib/video/candidate-types';
import type { CandidateDuplicateGroup } from '@/lib/video/candidate-technical-selection';
import type { FrameTechnicalAnalysis } from '@/lib/video/frame-technical-analysis';
import { MAX_TRANSCRIPTION_UPLOAD_BYTES } from '@/lib/video/transcript';

export const VIDEO_INTELLIGENCE_PREPARATION_VERSION = 1 as const;
export const VIDEO_INTELLIGENCE_PREPARATION_ARTIFACT_TYPE = 'VIDEO_INTELLIGENCE_PREPARATION' as const;
export const VIDEO_INTELLIGENCE_PREPARATION_PIPELINE_VERSION = 'video-preparation-v1' as const;
export const VIDEO_INTELLIGENCE_TRANSCRIPTION_MODEL = 'whisper-1' as const;
export const MAX_VIDEO_INTELLIGENCE_REPRESENTATIVE_BUNDLE_BYTES = 128 * 1024 * 1024;
export const MAX_VIDEO_INTELLIGENCE_PREPARATION_MANIFEST_BYTES = 2 * 1024 * 1024;

export type VideoIntelligencePreparationCandidate = Omit<
  TemporaryVideoFrameCandidate,
  'temporaryPath' | 'lifecycle'
> & { technical: FrameTechnicalAnalysis };

export interface VideoIntelligenceRepresentativeBundleEntry {
  candidateIndex: number; offset: number; byteLength: number;
}

export interface VideoIntelligenceAnalyzerFingerprint {
  pipelineVersion: typeof VIDEO_INTELLIGENCE_PREPARATION_PIPELINE_VERSION;
  candidatePolicy: VideoFrameCandidatePolicy; visionModel: string;
  transcriptionModel: typeof VIDEO_INTELLIGENCE_TRANSCRIPTION_MODEL;
  sha256: string;
}

export interface VideoIntelligencePreparationManifest {
  version: typeof VIDEO_INTELLIGENCE_PREPARATION_VERSION;
  artifactType: typeof VIDEO_INTELLIGENCE_PREPARATION_ARTIFACT_TYPE;
  providerEligible: false;
  sourceVideoMediaId: string; sourceVideoFileName: string;
  sourceVideoContentHash: string; sourceVideoByteLength: number;
  durationMs: number;
  effectiveIntervalFps: number;
  analyzerFingerprint: VideoIntelligenceAnalyzerFingerprint;
  candidates: VideoIntelligencePreparationCandidate[];
  groups: CandidateDuplicateGroup[];
  representativeBundle: {
    key: string;
    sha256: string;
    byteLength: number;
    entries: VideoIntelligenceRepresentativeBundleEntry[];
  };
}

export const createVideoIntelligenceAnalyzerFingerprint = (
  policy: VideoFrameCandidatePolicy,
  visionModel: string
) => {
  validateVideoFrameCandidatePolicy(policy);
  const normalizedVisionModel = visionModel.trim();
  if (!normalizedVisionModel) {
    throw new Error('Video preparation vision model must be non-empty.');
  }
  const encoding = JSON.stringify([
    VIDEO_INTELLIGENCE_PREPARATION_PIPELINE_VERSION,
    policy.targetIntervalFps,
    policy.maxIntervalCandidates,
    policy.maxTotalCandidates,
    policy.maxWidth,
    policy.imageFormat,
    policy.jpegQuality,
    normalizedVisionModel,
    VIDEO_INTELLIGENCE_TRANSCRIPTION_MODEL,
  ]);
  return {
    pipelineVersion: VIDEO_INTELLIGENCE_PREPARATION_PIPELINE_VERSION,
    candidatePolicy: { ...policy },
    visionModel: normalizedVisionModel,
    transcriptionModel: VIDEO_INTELLIGENCE_TRANSCRIPTION_MODEL,
    sha256: createHash('sha256').update(encoding).digest('hex'),
  };
};

const SHA256 = /^[a-f0-9]{64}$/;
const EXTRACTION_REASONS = new Set(['INTERVAL', 'SCENE_CHANGE']);
const reject = (reason: string): never => {
  throw new Error(`Video intelligence preparation manifest rejected: ${reason}`);
};
const positiveSafeInteger = (value: number) =>
  Number.isSafeInteger(value) && value > 0;
const finiteNumber = (value: number) => Number.isFinite(value);
const policiesMatch = (first: VideoFrameCandidatePolicy, second: VideoFrameCandidatePolicy) =>
  first.targetIntervalFps === second.targetIntervalFps
  && first.maxIntervalCandidates === second.maxIntervalCandidates
  && first.maxTotalCandidates === second.maxTotalCandidates
  && first.maxWidth === second.maxWidth
  && first.imageFormat === second.imageFormat
  && first.jpegQuality === second.jpegQuality;

const validTechnicalAnalysis = (technical: FrameTechnicalAnalysis) => {
  const finiteMetrics = [
    ...technical.meanRgb,
    technical.meanLuminance,
    technical.luminanceDeviation,
    technical.laplacianVariance,
    technical.darkFraction,
    technical.lightFraction,
    technical.qualityScore,
  ];
  return technical.version === 1
    && positiveSafeInteger(technical.analysisWidth)
    && positiveSafeInteger(technical.analysisHeight)
    && /^[a-f0-9]{16}$/.test(technical.differenceHash)
    && technical.meanRgb.length === 3
    && finiteMetrics.every(finiteNumber)
    && technical.darkFraction >= 0 && technical.darkFraction <= 1
    && technical.lightFraction >= 0 && technical.lightFraction <= 1;
};

export const validateVideoIntelligencePreparationManifest = (
  manifest: VideoIntelligencePreparationManifest
) => {
  let serializedBytes = 0;
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8');
  } catch {
    reject('manifest must be JSON serializable.');
  }
  if (serializedBytes > MAX_VIDEO_INTELLIGENCE_PREPARATION_MANIFEST_BYTES) {
    reject('manifest exceeds the 2 MiB limit.');
  }
  if (
    manifest.version !== VIDEO_INTELLIGENCE_PREPARATION_VERSION
    || manifest.artifactType !== VIDEO_INTELLIGENCE_PREPARATION_ARTIFACT_TYPE
    || manifest.providerEligible !== false
  ) reject('version, artifact type, or provider eligibility is invalid.');
  if (
    !manifest.sourceVideoMediaId
    || !manifest.sourceVideoFileName
    || !SHA256.test(manifest.sourceVideoContentHash)
    || !positiveSafeInteger(manifest.sourceVideoByteLength)
    || manifest.sourceVideoByteLength > MAX_TRANSCRIPTION_UPLOAD_BYTES
    || !finiteNumber(manifest.durationMs) || manifest.durationMs <= 0
    || !finiteNumber(manifest.effectiveIntervalFps) || manifest.effectiveIntervalFps <= 0
  ) reject('source or analyzer metadata is invalid.');

  const expectedFingerprint = (() => {
    try {
      return createVideoIntelligenceAnalyzerFingerprint(
        manifest.analyzerFingerprint.candidatePolicy,
        manifest.analyzerFingerprint.visionModel
      );
    } catch {
      return reject('analyzer settings are invalid.');
    }
  })();
  if (
    manifest.analyzerFingerprint.pipelineVersion !== expectedFingerprint.pipelineVersion
    || manifest.analyzerFingerprint.visionModel !== expectedFingerprint.visionModel
    || manifest.analyzerFingerprint.transcriptionModel !== expectedFingerprint.transcriptionModel
    || !policiesMatch(manifest.analyzerFingerprint.candidatePolicy, expectedFingerprint.candidatePolicy)
    || manifest.analyzerFingerprint.sha256 !== expectedFingerprint.sha256
    || manifest.effectiveIntervalFps !== getEffectiveIntervalFps(
      manifest.durationMs,
      manifest.analyzerFingerprint.candidatePolicy
    )
  ) reject('analyzer settings or fingerprint do not match.');
  if (
    manifest.candidates.length < 1
    || manifest.candidates.length > HARD_MAX_TOTAL_CANDIDATES
    || manifest.candidates.length > manifest.analyzerFingerprint.candidatePolicy.maxTotalCandidates
  ) reject('candidate count is outside the bounded policy.');

  let previousTimestampMs = -1;
  let intervalCandidateCount = 0;
  for (let index = 0; index < manifest.candidates.length; index += 1) {
    const candidate = manifest.candidates[index];
    if (
      candidate.candidateIndex !== index
      || !finiteNumber(candidate.timestampMs) || candidate.timestampMs < 0
      || candidate.timestampMs >= manifest.durationMs
      || candidate.timestampMs <= previousTimestampMs
    ) reject('candidate ordering or timestamp metadata is invalid.');
    if (
      candidate.sourceRole !== 'TRA_VIDEO'
      || candidate.sourceVideoMediaId !== manifest.sourceVideoMediaId
      || candidate.sourceVideoFileName !== manifest.sourceVideoFileName
      || candidate.sourceVideoContentHash !== manifest.sourceVideoContentHash
      || candidate.mimeType !== 'image/jpeg'
      || candidate.providerEligible !== false
    ) reject('candidate source or eligibility metadata is invalid.');
    if (
      !positiveSafeInteger(candidate.width)
      || candidate.width > manifest.analyzerFingerprint.candidatePolicy.maxWidth
      || !positiveSafeInteger(candidate.height)
      || !positiveSafeInteger(candidate.byteLength)
      || !SHA256.test(candidate.frameSha256)
      || !Array.isArray(candidate.extractionReasons)
      || candidate.extractionReasons.length < 1
      || candidate.extractionReasons.some((reason) => !EXTRACTION_REASONS.has(reason))
      || new Set(candidate.extractionReasons).size !== candidate.extractionReasons.length
      || !validTechnicalAnalysis(candidate.technical)
    ) reject('candidate integrity or analysis metadata is invalid.');
    if (candidate.extractionReasons.includes('INTERVAL')) intervalCandidateCount += 1;
    previousTimestampMs = candidate.timestampMs;
  }
  if (
    intervalCandidateCount < 1
    || intervalCandidateCount > manifest.analyzerFingerprint.candidatePolicy.maxIntervalCandidates
  ) reject('interval candidate count is outside the bounded policy.');

  const groupedCandidates = new Set<number>();
  const representatives = new Set<number>();
  for (const group of manifest.groups) {
    if (!group.candidateIndexes.length || !group.candidateIndexes.includes(group.representativeIndex)) {
      reject('group representative must be a member.');
    }
    if (representatives.has(group.representativeIndex)) reject('group representatives must be unique.');
    representatives.add(group.representativeIndex);
    let previousIndex = -1;
    for (const candidateIndex of group.candidateIndexes) {
      if (
        !Number.isSafeInteger(candidateIndex)
        || candidateIndex < 0 || candidateIndex >= manifest.candidates.length
        || candidateIndex <= previousIndex || groupedCandidates.has(candidateIndex)
      ) reject('group candidate membership is invalid.');
      groupedCandidates.add(candidateIndex);
      previousIndex = candidateIndex;
    }
  }
  if (groupedCandidates.size !== manifest.candidates.length) reject('groups must cover every candidate exactly once.');

  const bundle = manifest.representativeBundle;
  if (!bundle.key || !SHA256.test(bundle.sha256) || !Number.isSafeInteger(bundle.byteLength)) {
    reject('representative bundle metadata is invalid.');
  }
  if (bundle.entries.length !== representatives.size) reject('bundle must index every representative exactly once.');
  let expectedOffset = 0;
  let previousRepresentativeIndex = -1;
  const indexedRepresentatives = new Set<number>();
  for (const entry of bundle.entries) {
    const candidate = manifest.candidates[entry.candidateIndex];
    if (
      !candidate || !representatives.has(entry.candidateIndex)
      || indexedRepresentatives.has(entry.candidateIndex)
      || entry.candidateIndex <= previousRepresentativeIndex
      || entry.offset !== expectedOffset
      || entry.byteLength !== candidate.byteLength
    ) reject('representative bundle index is invalid.');
    indexedRepresentatives.add(entry.candidateIndex);
    expectedOffset += entry.byteLength;
    if (!Number.isSafeInteger(expectedOffset)) reject('representative bundle length is invalid.');
    previousRepresentativeIndex = entry.candidateIndex;
  }
  if (
    expectedOffset !== bundle.byteLength
    || bundle.byteLength > MAX_VIDEO_INTELLIGENCE_REPRESENTATIVE_BUNDLE_BYTES
  ) reject('representative bundle length is invalid.');
  return manifest;
};
