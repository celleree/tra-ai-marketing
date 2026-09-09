import { createHash } from 'node:crypto';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import type { TemporaryVideoFrameCandidateSet } from '@/lib/video/candidate-types';
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
    write: vi.fn(async (key, bytes, expectedEtag) => {
      expect(expectedEtag).toBeNull();
      if (artifacts.has(key)) return false;
      artifacts.set(key, Buffer.from(bytes));
      return true;
    }),
  };
  return { artifacts, storage };
};

const makeCandidateSet = async (directory: string, count = 3) => {
  const videoPath = path.join(directory, 'source.mp4');
  await writeFile(videoPath, sourceBytes);
  const candidates = [];
  for (let candidateIndex = 0; candidateIndex < count; candidateIndex += 1) {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: candidateIndex * 70, g: 20, b: 30 } },
    }).jpeg().toBuffer();
    const temporaryPath = path.join(directory, `candidate-${candidateIndex}.jpg`);
    await writeFile(temporaryPath, bytes);
    candidates.push({
      candidateIndex,
      timestampMs: candidateIndex * 100,
      sourceRole: 'TRA_VIDEO' as const,
      sourceVideoMediaId: source.media.id,
      sourceVideoFileName: source.media.fileName,
      sourceVideoContentHash: sourceHash,
      mimeType: 'image/jpeg' as const,
      width: 2,
      height: 2,
      byteLength: bytes.length,
      frameSha256: sha256(bytes),
      extractionReasons: count > 1 && candidateIndex === count - 1 ? ['SCENE_CHANGE'] as const : ['INTERVAL'] as const,
      temporaryPath,
      lifecycle: 'TEMPORARY' as const,
      providerEligible: false as const,
    });
  }
  return {
    sourceVideoMediaId: source.media.id,
    sourceVideoFileName: source.media.fileName,
    sourceVideoContentHash: sourceHash,
    durationMs: Math.max(1_000, count * 100 + 1),
    policy: { ...DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY },
    effectiveIntervalFps: 3,
    candidates,
    temporarySourceVideoPath: videoPath,
    temporaryDirectories: [directory],
  } satisfies TemporaryVideoFrameCandidateSet;
};

describe('video intelligence preparation persistence', () => {
  it('persists deterministic content-addressed artifacts without temporary capability metadata', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tra-video-candidates-'));
    const set = await makeCandidateSet(directory);
    const firstStorage = artifactStorage();
    const first = await prepareAndPersistVideoIntelligencePreparation(
      source,
      { visionModel: '  vision-model-1  ' },
      { storage: firstStorage.storage, preprocessCandidates: vi.fn(async () => set) }
    );

    expect(first.manifestKey).toMatch(/^preparations\/manifests\/sha256\/[a-f0-9]{64}\.json$/);
    expect(first.manifest.representativeBundle.key).toMatch(/^preparations\/bundles\/sha256\/[a-f0-9]{64}\.bin$/);
    expect(first.manifest.analyzerFingerprint).toMatchObject({ visionModel: 'vision-model-1', candidatePolicy: DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY });
    expect(first.manifest.candidates).toHaveLength(3);
    expect(JSON.stringify(first.manifest)).not.toMatch(/temporaryPath|lifecycle/);
    expect(first.manifest.providerEligible).toBe(false);
    expect(first.manifest.candidates.every((candidate) => candidate.providerEligible === false)).toBe(true);
    expect([...firstStorage.artifacts.keys()]).toEqual([
      first.manifest.representativeBundle.key,
      first.manifestKey,
    ]);
    expect(sha256(firstStorage.artifacts.get(first.manifestKey)!)).toBe(first.manifestSha256);

    const secondDirectory = await mkdtemp(path.join(os.tmpdir(), 'tra-video-candidates-'));
    const secondSet = await makeCandidateSet(secondDirectory);
    const secondStorage = artifactStorage();
    const second = await prepareAndPersistVideoIntelligencePreparation(
      source,
      { visionModel: 'vision-model-1' },
      { storage: secondStorage.storage, preprocessCandidates: vi.fn(async () => secondSet) }
    );
    expect(second).toEqual(first);
    expect(secondStorage.artifacts.get(second.manifestKey)).toEqual(firstStorage.artifacts.get(first.manifestKey));
  });

  it('accepts exact create collisions and rejects differing immutable bytes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tra-video-candidates-'));
    const set = await makeCandidateSet(directory);
    const stored = artifactStorage();
    const first = await prepareAndPersistVideoIntelligencePreparation(
      source,
      { visionModel: 'vision-model-1' },
      { storage: stored.storage, preprocessCandidates: vi.fn(async () => set) }
    );
    const retryDirectory = await mkdtemp(path.join(os.tmpdir(), 'tra-video-candidates-'));
    await expect(prepareAndPersistVideoIntelligencePreparation(
      source,
      { visionModel: 'vision-model-1' },
      { storage: stored.storage, preprocessCandidates: vi.fn(async () => makeCandidateSet(retryDirectory)) }
    )).resolves.toEqual(first);

    stored.artifacts.set(first.manifest.representativeBundle.key, Buffer.from('collision'));
    const collisionDirectory = await mkdtemp(path.join(os.tmpdir(), 'tra-video-candidates-'));
    await expect(prepareAndPersistVideoIntelligencePreparation(
      source,
      { visionModel: 'vision-model-1' },
      { storage: stored.storage, preprocessCandidates: vi.fn(async () => makeCandidateSet(collisionDirectory)) }
    )).rejects.toThrow('immutable artifact collision');
  });

  it('rejects an oversized representative bundle before allocation or candidate reads', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tra-video-candidates-'));
    const set = await makeCandidateSet(directory, 1);
    set.candidates[0].byteLength = 128 * 1024 * 1024 + 1;
    const readCandidateFile = vi.fn();
    const storage = artifactStorage().storage;
    const runCandidateLifecycle = async <T>(
      _source: HydratedTraVideoSource,
      consumer: (candidateSet: TemporaryVideoFrameCandidateSet) => T | Promise<T>
    ) => consumer(set);
    await expect(prepareAndPersistVideoIntelligencePreparation(
      source,
      { visionModel: 'vision-model-1' },
      { storage, readCandidateFile, runCandidateLifecycle }
    )).rejects.toThrow('128 MiB');
    expect(readCandidateFile).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('revalidates representative bytes and cleans actual lifecycle ownership after storage failure', async () => {
    const corruptDirectory = await mkdtemp(path.join(os.tmpdir(), 'tra-video-candidates-'));
    const corruptSet = await makeCandidateSet(corruptDirectory, 1);
    const corruptBytes = Buffer.from(await sharp({ create: { width: 3, height: 2, channels: 3, background: '#ffffff' } }).jpeg().toBuffer());
    await expect(prepareAndPersistVideoIntelligencePreparation(
      source,
      { visionModel: 'vision-model-1' },
      { storage: artifactStorage().storage, readCandidateFile: vi.fn(async () => corruptBytes), preprocessCandidates: vi.fn(async () => corruptSet) }
    )).rejects.toThrow('failed integrity validation');
    await expect(access(corruptDirectory)).rejects.toMatchObject({ code: 'ENOENT' });

    const failingDirectory = await mkdtemp(path.join(os.tmpdir(), 'tra-video-candidates-'));
    const failingSet = await makeCandidateSet(failingDirectory, 1);
    const failure = new Error('storage unavailable');
    const storage: VideoIntelligenceStorage = {
      read: vi.fn(),
      write: vi.fn(async () => { throw failure; }),
    };
    await expect(prepareAndPersistVideoIntelligencePreparation(
      source,
      { visionModel: 'vision-model-1' },
      { storage, preprocessCandidates: vi.fn(async () => failingSet) }
    )).rejects.toBe(failure);
    await expect(access(failingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an oversized source before preprocessing or storage', async () => {
    const preprocessCandidates = vi.fn();
    const storage = artifactStorage().storage;
    const oversized = {
      ...source,
      stored: { ...source.stored, buffer: Buffer.alloc(25_000_001) },
    };
    await expect(prepareAndPersistVideoIntelligencePreparation(
      oversized,
      { visionModel: 'vision-model-1' },
      { storage, preprocessCandidates }
    )).rejects.toThrow('25 MB');
    expect(preprocessCandidates).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
  });

});
