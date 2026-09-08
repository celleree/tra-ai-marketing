import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import type { TemporaryVideoFrameCandidateSet } from '@/lib/video/candidate-types';
import {
  createVideoIntelligenceAnalyzerFingerprint,
  type VideoIntelligencePreparationManifest,
} from '@/lib/video/intelligence-preparation';
import { loadVideoIntelligencePreparation } from '@/lib/video/intelligence-preparation-loader';
import { prepareAndPersistVideoIntelligencePreparation } from '@/lib/video/intelligence-preparation-persistence';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = Buffer.from('source-mp4-bytes');
const sourceHash = sha256(sourceBytes);
const source = {
  role: 'TRA_VIDEO',
  media: { id: 'media-video-1', fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', size: sourceBytes.length, url: '/media/source.mp4' },
  stored: { fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', buffer: sourceBytes },
} as HydratedTraVideoSource;

const artifactStorage = () => {
  const artifacts = new Map<string, Buffer>();
  const storage: VideoIntelligenceStorage = {
    read: vi.fn(async (key) => {
      const bytes = artifacts.get(key);
      return bytes ? { bytes: Buffer.from(bytes), etag: sha256(bytes) } : null;
    }),
    write: vi.fn(async (key, bytes) => {
      if (artifacts.has(key)) return false;
      artifacts.set(key, Buffer.from(bytes));
      return true;
    }),
  };
  return { artifacts, storage };
};

const inputFor = (manifestKey: string, manifestSha256: string, analyzerFingerprintSha256: string) => ({
  manifestKey,
  manifestSha256,
  expectedSourceVideoMediaId: source.media.id,
  expectedSourceVideoContentHash: sourceHash,
  expectedAnalyzerFingerprintSha256: analyzerFingerprintSha256,
});

const persistFixture = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tra-video-candidates-loader-'));
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#663399' } }).jpeg().toBuffer();
  const candidatePath = path.join(directory, 'candidate.jpg');
  await writeFile(candidatePath, bytes);
  const candidateSet: TemporaryVideoFrameCandidateSet = {
    sourceVideoMediaId: source.media.id, sourceVideoFileName: source.media.fileName,
    sourceVideoContentHash: sourceHash, durationMs: 1_000,
    policy: { ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY }, effectiveIntervalFps: 3,
    candidates: [{
      candidateIndex: 0, timestampMs: 0, sourceRole: 'TRA_VIDEO',
      sourceVideoMediaId: source.media.id, sourceVideoFileName: source.media.fileName,
      sourceVideoContentHash: sourceHash, mimeType: 'image/jpeg', width: 2, height: 2,
      byteLength: bytes.length, frameSha256: sha256(bytes), extractionReasons: ['INTERVAL'],
      temporaryPath: candidatePath, lifecycle: 'TEMPORARY', providerEligible: false,
    }],
    temporarySourceVideoPath: path.join(directory, 'source.mp4'), temporaryDirectories: [directory],
  };
  await writeFile(candidateSet.temporarySourceVideoPath, sourceBytes);
  const fixture = artifactStorage();
  const persisted = await prepareAndPersistVideoIntelligencePreparation(
    source,
    { visionModel: 'vision-model-1' },
    { storage: fixture.storage, preprocessCandidates: vi.fn(async () => candidateSet) }
  );
  return { ...fixture, persisted };
};

const manifestWithRepresentatives = async (count: number) => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#663399' } }).jpeg().toBuffer();
  const frameSha256 = sha256(bytes);
  const candidates = Array.from({ length: count }, (_, candidateIndex) => ({
    candidateIndex, timestampMs: candidateIndex * 100, sourceRole: 'TRA_VIDEO' as const,
    sourceVideoMediaId: source.media.id, sourceVideoFileName: source.media.fileName,
    sourceVideoContentHash: sourceHash, mimeType: 'image/jpeg' as const, width: 2, height: 2,
    byteLength: bytes.length, frameSha256,
    extractionReasons: (candidateIndex < 360 ? ['INTERVAL'] : ['SCENE_CHANGE']) as ['INTERVAL'] | ['SCENE_CHANGE'],
    providerEligible: false as const,
    technical: { version: 1 as const, analysisWidth: 2, analysisHeight: 2, differenceHash: '0'.repeat(16), meanRgb: [1, 1, 1] as [number, number, number], meanLuminance: 1, luminanceDeviation: 1, laplacianVariance: 1, darkFraction: 0, lightFraction: 0, qualityScore: 1 },
  }));
  const bundle = Buffer.concat(Array.from({ length: count }, () => bytes));
  const fingerprint = createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'vision-model-1');
  const manifest: VideoIntelligencePreparationManifest = {
    version: 1, artifactType: 'VIDEO_INTELLIGENCE_PREPARATION', providerEligible: false,
    sourceVideoMediaId: source.media.id, sourceVideoFileName: source.media.fileName,
    sourceVideoContentHash: sourceHash, sourceVideoByteLength: sourceBytes.length,
    durationMs: count * 100, effectiveIntervalFps: 3, analyzerFingerprint: fingerprint,
    candidates, groups: candidates.map(({ candidateIndex }) => ({ representativeIndex: candidateIndex, candidateIndexes: [candidateIndex] })),
    representativeBundle: {
      key: `preparations/bundles/sha256/${sha256(bundle)}.bin`, sha256: sha256(bundle), byteLength: bundle.length,
      entries: candidates.map(({ candidateIndex }) => ({ candidateIndex, offset: candidateIndex * bytes.length, byteLength: bytes.length })),
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return { bundle, manifest, manifestBytes, manifestKey: `preparations/manifests/sha256/${sha256(manifestBytes)}.json`, manifestSha256: sha256(manifestBytes) };
};

describe('video intelligence preparation loader', () => {
  it('loads writer artifacts into validated representative metadata and shared bundle slices', async () => {
    const { storage, persisted } = await persistFixture();
    const loaded = await loadVideoIntelligencePreparation(
      inputFor(persisted.manifestKey, persisted.manifestSha256, persisted.manifest.analyzerFingerprint.sha256),
      { storage }
    );
    expect(loaded.manifest).toEqual(persisted.manifest);
    expect(loaded.representatives).toHaveLength(1);
    expect(loaded.representatives[0].candidate).toEqual(persisted.manifest.candidates[0]);
    expect(loaded.representatives[0].bytes).toHaveLength(persisted.manifest.candidates[0].byteLength);
  });

  it('preserves all 480 representatives without copying their bundle slices', async () => {
    const fixture = await manifestWithRepresentatives(480);
    const { artifacts, storage } = artifactStorage();
    artifacts.set(fixture.manifestKey, fixture.manifestBytes);
    artifacts.set(fixture.manifest.representativeBundle.key, fixture.bundle);
    const loaded = await loadVideoIntelligencePreparation(
      inputFor(fixture.manifestKey, fixture.manifestSha256, fixture.manifest.analyzerFingerprint.sha256),
      { storage }
    );
    expect(loaded.representatives).toHaveLength(480);
    expect(loaded.representatives.every(({ bytes }) => bytes.buffer === loaded.representatives[0].bytes.buffer)).toBe(true);
  });

  it.each([
    ['missing manifest', async (artifacts: Map<string, Buffer>, fixture: Awaited<ReturnType<typeof persistFixture>>) => artifacts.delete(fixture.persisted.manifestKey), 'manifest artifact is missing'],
    ['corrupt manifest', async (artifacts: Map<string, Buffer>, fixture: Awaited<ReturnType<typeof persistFixture>>) => artifacts.set(fixture.persisted.manifestKey, Buffer.from('not-json')), 'manifest digest'],
    ['missing bundle', async (artifacts: Map<string, Buffer>, fixture: Awaited<ReturnType<typeof persistFixture>>) => artifacts.delete(fixture.persisted.manifest.representativeBundle.key), 'bundle artifact is missing'],
    ['corrupt bundle', async (artifacts: Map<string, Buffer>, fixture: Awaited<ReturnType<typeof persistFixture>>) => artifacts.set(fixture.persisted.manifest.representativeBundle.key, Buffer.from('corrupt')), 'bundle length'],
  ])('rejects a %s artifact before use', async (_label, mutate, message) => {
    const fixture = await persistFixture();
    await mutate(fixture.artifacts, fixture);
    await expect(loadVideoIntelligencePreparation(
      inputFor(fixture.persisted.manifestKey, fixture.persisted.manifestSha256, fixture.persisted.manifest.analyzerFingerprint.sha256),
      { storage: fixture.storage }
    )).rejects.toThrow(message);
  });

  it('rejects malformed identities and oversized raw manifests before parsing', async () => {
    const { storage, persisted, artifacts } = await persistFixture();
    await expect(loadVideoIntelligencePreparation(
      { ...inputFor(persisted.manifestKey, persisted.manifestSha256, persisted.manifest.analyzerFingerprint.sha256), manifestKey: 'wrong.json' },
      { storage }
    )).rejects.toThrow('manifest identity');
    artifacts.set(persisted.manifestKey, Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(loadVideoIntelligencePreparation(
      inputFor(persisted.manifestKey, persisted.manifestSha256, persisted.manifest.analyzerFingerprint.sha256),
      { storage }
    )).rejects.toThrow('2 MiB');
  });

  it('rejects an invalid manifest shape and mismatched expected source or analyzer', async () => {
    const { storage, persisted, artifacts } = await persistFixture();
    const invalidBytes = Buffer.from('{}');
    const invalidSha256 = sha256(invalidBytes);
    const invalidKey = `preparations/manifests/sha256/${invalidSha256}.json`;
    artifacts.set(invalidKey, invalidBytes);
    await expect(loadVideoIntelligencePreparation(
      inputFor(invalidKey, invalidSha256, persisted.manifest.analyzerFingerprint.sha256),
      { storage }
    )).rejects.toThrow('manifest shape or integrity');
    await expect(loadVideoIntelligencePreparation(
      { ...inputFor(persisted.manifestKey, persisted.manifestSha256, persisted.manifest.analyzerFingerprint.sha256), expectedAnalyzerFingerprintSha256: 'a'.repeat(64) },
      { storage }
    )).rejects.toThrow('expected source or analyzer');
  });
});
