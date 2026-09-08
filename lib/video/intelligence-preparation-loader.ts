import { createHash } from 'node:crypto';
import { getJpegDimensions } from '@/lib/video/candidate-file-integrity';
import {
  MAX_VIDEO_INTELLIGENCE_PREPARATION_MANIFEST_BYTES,
  MAX_VIDEO_INTELLIGENCE_REPRESENTATIVE_BUNDLE_BYTES,
  validateVideoIntelligencePreparationManifest,
  type VideoIntelligencePreparationCandidate,
  type VideoIntelligencePreparationManifest,
} from '@/lib/video/intelligence-preparation';
import {
  getVideoIntelligenceStorage,
  type VideoIntelligenceStorage,
} from '@/lib/video/intelligence-storage';

const SHA256 = /^[a-f0-9]{64}$/;

export interface LoadVideoIntelligencePreparationInput {
  manifestKey: string;
  manifestSha256: string;
  expectedSourceVideoMediaId: string;
  expectedSourceVideoContentHash: string;
  expectedAnalyzerFingerprintSha256: string;
}

export interface LoadedVideoIntelligencePreparationRepresentative {
  candidate: VideoIntelligencePreparationCandidate;
  bytes: Buffer;
}

export interface LoadedVideoIntelligencePreparation {
  manifest: VideoIntelligencePreparationManifest;
  representatives: LoadedVideoIntelligencePreparationRepresentative[];
}

const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

const reject = (reason: string): never => {
  throw new Error(`Video intelligence preparation load rejected: ${reason}`);
};

const manifestKeyFor = (digest: string) =>
  `preparations/manifests/sha256/${digest}.json`;

const bundleKeyFor = (digest: string) =>
  `preparations/bundles/sha256/${digest}.bin`;

const parseManifest = (bytes: Buffer): VideoIntelligencePreparationManifest => {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return reject('manifest is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return reject('manifest must be an object.');
  }
  try {
    return validateVideoIntelligencePreparationManifest(value as VideoIntelligencePreparationManifest);
  } catch {
    return reject('manifest shape or integrity is invalid.');
  }
};

export const loadVideoIntelligencePreparation = async (
  input: LoadVideoIntelligencePreparationInput,
  dependencies: { storage?: VideoIntelligenceStorage } = {}
): Promise<LoadedVideoIntelligencePreparation> => {
  if (
    !SHA256.test(input.manifestSha256)
    || !SHA256.test(input.expectedSourceVideoContentHash)
    || !SHA256.test(input.expectedAnalyzerFingerprintSha256)
    || !input.expectedSourceVideoMediaId
    || input.manifestKey !== manifestKeyFor(input.manifestSha256)
  ) {
    return reject('manifest identity or expected source metadata is invalid.');
  }

  const storage = dependencies.storage ?? getVideoIntelligenceStorage();
  const storedManifest = await storage.read(input.manifestKey);
  if (!storedManifest) return reject('manifest artifact is missing.');
  if (storedManifest.bytes.length > MAX_VIDEO_INTELLIGENCE_PREPARATION_MANIFEST_BYTES) {
    return reject('manifest exceeds the 2 MiB limit.');
  }
  if (sha256(storedManifest.bytes) !== input.manifestSha256) {
    return reject('manifest digest does not match its identity.');
  }

  const manifest = parseManifest(storedManifest.bytes);
  if (
    manifest.sourceVideoMediaId !== input.expectedSourceVideoMediaId
    || manifest.sourceVideoContentHash !== input.expectedSourceVideoContentHash
    || manifest.analyzerFingerprint.sha256 !== input.expectedAnalyzerFingerprintSha256
  ) {
    return reject('manifest does not match the expected source or analyzer.');
  }
  if (manifest.representativeBundle.key !== bundleKeyFor(manifest.representativeBundle.sha256)) {
    return reject('representative bundle key does not match its digest.');
  }

  const storedBundle = await storage.read(manifest.representativeBundle.key);
  if (!storedBundle) return reject('representative bundle artifact is missing.');
  const bundle = storedBundle.bytes;
  if (bundle.length > MAX_VIDEO_INTELLIGENCE_REPRESENTATIVE_BUNDLE_BYTES) {
    return reject('representative bundle exceeds the 128 MiB limit.');
  }
  if (bundle.length !== manifest.representativeBundle.byteLength) {
    return reject('representative bundle length does not match the manifest.');
  }
  if (sha256(bundle) !== manifest.representativeBundle.sha256) {
    return reject('representative bundle digest does not match the manifest.');
  }

  const representatives = manifest.representativeBundle.entries.map((entry) => {
    const candidate = manifest.candidates[entry.candidateIndex];
    const bytes = bundle.subarray(entry.offset, entry.offset + entry.byteLength);
    const dimensions = getJpegDimensions(bytes);
    if (
      bytes.length !== candidate.byteLength
      || sha256(bytes) !== candidate.frameSha256
      || dimensions?.width !== candidate.width
      || dimensions.height !== candidate.height
    ) {
      return reject(`representative candidate ${entry.candidateIndex} failed integrity validation.`);
    }
    return { candidate, bytes };
  });

  return { manifest, representatives };
};
