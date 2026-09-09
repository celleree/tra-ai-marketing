import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import type {
  TemporaryVideoFrameCandidateSet,
  VideoFrameCandidatePolicy,
} from '@/lib/video/candidate-types';
import { cleanupTemporaryVideoFrameCandidateOwnership } from '@/lib/video/candidate-cleanup';
import { getJpegDimensions } from '@/lib/video/candidate-file-integrity';
import { withTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-lifecycle';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import { analyzeTemporaryVideoCandidates } from '@/lib/video/candidate-technical-selection';
import {
  MAX_VIDEO_INTELLIGENCE_REPRESENTATIVE_BUNDLE_BYTES,
  createVideoIntelligenceAnalyzerFingerprint,
  validateVideoIntelligencePreparationManifest,
  type VideoIntelligencePreparationManifest,
} from '@/lib/video/intelligence-preparation';
import {
  getVideoIntelligenceStorage,
  type VideoIntelligenceStorage,
} from '@/lib/video/intelligence-storage';
import { MAX_TRANSCRIPTION_UPLOAD_BYTES } from '@/lib/video/transcript';

type CandidatePreprocessor = (
  source: HydratedTraVideoSource,
  policy: VideoFrameCandidatePolicy
) => Promise<TemporaryVideoFrameCandidateSet>;

interface VideoIntelligencePreparationPersistenceDependencies {
  storage?: VideoIntelligenceStorage;
  readCandidateFile?: (temporaryPath: string) => Promise<Buffer>;
  runCandidateLifecycle?: typeof withTemporaryTraVideoFrameCandidates;
  preprocessCandidates?: CandidatePreprocessor;
  cleanupCandidateOwnership?: typeof cleanupTemporaryVideoFrameCandidateOwnership;
}

export interface PersistedVideoIntelligencePreparation {
  manifestKey: string;
  manifestSha256: string;
  manifest: VideoIntelligencePreparationManifest;
}

const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

const bundleKey = (digest: string) =>
  `preparations/bundles/sha256/${digest}.bin`;

const manifestKey = (digest: string) =>
  `preparations/manifests/sha256/${digest}.json`;

const createImmutableArtifact = async (
  storage: VideoIntelligenceStorage,
  key: string,
  bytes: Buffer
) => {
  if (await storage.write(key, bytes, null)) return;

  const existing = await storage.read(key);
  const expectedDigest = sha256(bytes);
  if (
    !existing
    || existing.bytes.length !== bytes.length
    || sha256(existing.bytes) !== expectedDigest
    || !existing.bytes.equals(bytes)
  ) {
    throw new Error(`Video intelligence immutable artifact collision at ${key}.`);
  }
};

const rejectPreparation = (reason: string): never => {
  throw new Error(`Video intelligence preparation persistence rejected: ${reason}`);
};

export const prepareAndPersistVideoIntelligencePreparation = async (
  source: HydratedTraVideoSource,
  options: {
    visionModel: string;
    policy?: VideoFrameCandidatePolicy;
  },
  dependencies: VideoIntelligencePreparationPersistenceDependencies = {}
): Promise<PersistedVideoIntelligencePreparation> => {
  const sourceByteLength = source.stored.buffer.length;
  if (sourceByteLength < 1 || sourceByteLength > MAX_TRANSCRIPTION_UPLOAD_BYTES) {
    rejectPreparation('source video must be between 1 byte and 25 MB.');
  }

  const policy = { ...(options.policy ?? DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY) };
  const storage = dependencies.storage ?? getVideoIntelligenceStorage();
  const readCandidateFile = dependencies.readCandidateFile
    ?? ((temporaryPath: string) => readFile(temporaryPath));
  const runCandidateLifecycle = dependencies.runCandidateLifecycle
    ?? withTemporaryTraVideoFrameCandidates;

  return runCandidateLifecycle(
    source,
    async (candidateSet) => {
      const selection = await analyzeTemporaryVideoCandidates(candidateSet);
      const analyzedByIndex = new Map(
        selection.candidates.map((candidate) => [candidate.candidateIndex, candidate])
      );
      const candidates = candidateSet.candidates.map((candidate) => {
        const analyzed = analyzedByIndex.get(candidate.candidateIndex);
        if (!analyzed || analyzed.frameSha256 !== candidate.frameSha256) {
          return rejectPreparation('technical analysis does not match the candidate set.');
        }
        const { temporaryPath: _temporaryPath, lifecycle: _lifecycle, ...persisted } = candidate;
        return { ...persisted, technical: analyzed.technical };
      });

      const representativeIndexes = selection.groups
        .map((group) => group.representativeIndex)
        .sort((first, second) => first - second);
      let representativeByteLength = 0;
      for (const candidateIndex of representativeIndexes) {
        const byteLength = candidateSet.candidates[candidateIndex]?.byteLength;
        if (
          !Number.isSafeInteger(byteLength)
          || !Number.isSafeInteger(representativeByteLength + byteLength)
          || representativeByteLength + byteLength > MAX_VIDEO_INTELLIGENCE_REPRESENTATIVE_BUNDLE_BYTES
        ) {
          rejectPreparation('representative bundle exceeds the 128 MiB limit.');
        }
        representativeByteLength += byteLength;
      }

      const representativeBundleBytes = Buffer.alloc(representativeByteLength);
      const entries = [];
      let offset = 0;
      for (const candidateIndex of representativeIndexes) {
        const candidate = candidateSet.candidates[candidateIndex];
        const bytes = await readCandidateFile(candidate.temporaryPath);
        const dimensions = getJpegDimensions(bytes);
        if (
          bytes.length !== candidate.byteLength
          || sha256(bytes) !== candidate.frameSha256
          || dimensions?.width !== candidate.width
          || dimensions.height !== candidate.height
        ) {
          rejectPreparation(`representative candidate ${candidateIndex} failed integrity validation.`);
        }
        entries.push({ candidateIndex, offset, byteLength: bytes.length });
        bytes.copy(representativeBundleBytes, offset);
        offset += bytes.length;
      }

      const representativeBundleSha256 = sha256(representativeBundleBytes);
      const manifest: VideoIntelligencePreparationManifest = {
        version: 1,
        artifactType: 'VIDEO_INTELLIGENCE_PREPARATION',
        providerEligible: false,
        sourceVideoMediaId: candidateSet.sourceVideoMediaId,
        sourceVideoFileName: candidateSet.sourceVideoFileName,
        sourceVideoContentHash: candidateSet.sourceVideoContentHash,
        sourceVideoByteLength: sourceByteLength,
        durationMs: candidateSet.durationMs,
        effectiveIntervalFps: candidateSet.effectiveIntervalFps,
        analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(
          candidateSet.policy,
          options.visionModel
        ),
        candidates,
        groups: selection.groups,
        representativeBundle: {
          key: bundleKey(representativeBundleSha256),
          sha256: representativeBundleSha256,
          byteLength: representativeBundleBytes.length,
          entries,
        },
      };
      validateVideoIntelligencePreparationManifest(manifest);
      const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
      const manifestSha256 = sha256(manifestBytes);
      const resolvedManifestKey = manifestKey(manifestSha256);

      await createImmutableArtifact(
        storage,
        manifest.representativeBundle.key,
        representativeBundleBytes
      );
      await createImmutableArtifact(storage, resolvedManifestKey, manifestBytes);

      return { manifestKey: resolvedManifestKey, manifestSha256, manifest };
    },
    {
      preprocessCandidates: dependencies.preprocessCandidates,
      cleanupCandidateOwnership: dependencies.cleanupCandidateOwnership,
    },
    policy
  );
};
