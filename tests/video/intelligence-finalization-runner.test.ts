import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, getEffectiveIntervalFps } from '@/lib/video/candidate-policy';
import { analyzeFrameTechnicalQuality } from '@/lib/video/frame-technical-analysis';
import { createVideoFrameThumbnailFromBytes } from '@/lib/video/frame-thumbnail';
import { createVideoIntelligenceAnalyzerFingerprint, type VideoIntelligencePreparationManifest } from '@/lib/video/intelligence-preparation';
import { videoIntelligenceJobKey } from '@/lib/video/intelligence-job';
import { checkpointVideoIntelligenceJob, claimVideoIntelligenceJob, readVideoIntelligenceJob, startVideoIntelligenceJob, VideoIntelligenceJobLeaseLostError } from '@/lib/video/intelligence-job-store';
import { loadVideoIntelligenceLibrary, MAX_VIDEO_INTELLIGENCE_LIBRARY_BYTES, runVideoIntelligenceFinalizationJob } from '@/lib/video/intelligence-finalization-runner';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const mediaId = `media_${'a'.repeat(32)}`;
const identity = { sourceVideoMediaId: mediaId, sourceVideoContentHash: sha('source'),
  analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'vision-model') };
const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#663399' } }).jpeg().toBuffer();
const candidate = { candidateIndex: 0, timestampMs: 0, sourceRole: 'TRA_VIDEO' as const,
  sourceVideoMediaId: mediaId, sourceVideoFileName: `${mediaId}.mp4`, sourceVideoContentHash: identity.sourceVideoContentHash,
  mimeType: 'image/jpeg' as const, width: 2, height: 2, byteLength: jpeg.length, frameSha256: sha(jpeg),
  extractionReasons: ['INTERVAL'] as const, providerEligible: false as const, technical: await analyzeFrameTechnicalQuality(jpeg) };
const manifest: VideoIntelligencePreparationManifest = {
  version: 1, artifactType: 'VIDEO_INTELLIGENCE_PREPARATION', providerEligible: false,
  sourceVideoMediaId: mediaId, sourceVideoFileName: candidate.sourceVideoFileName,
  sourceVideoContentHash: identity.sourceVideoContentHash, sourceVideoByteLength: 6, durationMs: 2_000,
  effectiveIntervalFps: getEffectiveIntervalFps(2_000, DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY),
  analyzerFingerprint: identity.analyzerFingerprint, candidates: [candidate],
  groups: [{ representativeIndex: 0, candidateIndexes: [0] }],
  representativeBundle: { key: `preparations/bundles/sha256/${sha(jpeg)}.bin`, sha256: sha(jpeg), byteLength: jpeg.length,
    entries: [{ candidateIndex: 0, offset: 0, byteLength: jpeg.length }] },
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const preparation = { manifestKey: `preparations/manifests/sha256/${sha(manifestBytes)}.json`,
  manifestSha256: sha(manifestBytes), durationMs: manifest.durationMs, representativeCandidateIndexes: [0] };
const thumbnail = await createVideoFrameThumbnailFromBytes(candidate, jpeg);
const observation = { version: 1 as const, model: 'vision-model', providerEligible: false as const,
  evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const, sourceVideoMediaId: mediaId,
  sourceVideoContentHash: identity.sourceVideoContentHash, candidateIndex: 0, timestampMs: 0, frameSha256: candidate.frameSha256,
  observation: { sceneType: 'OTHER' as const, summary: 'Colored fixture.', composition: 'Full frame.', visibleText: [], topics: ['other' as const], uncertainties: [] } };

class MemoryStorage implements VideoIntelligenceStorage {
  values = new Map<string, { bytes: Buffer; etag: string }>();
  version = 0;
  onWrite?: (key: string, bytes: Buffer) => Promise<void>;
  writes: Array<{ key: string; expected: string | null }> = [];
  async read(key: string) { const stored = this.values.get(key); return stored ? { ...stored, bytes: Buffer.from(stored.bytes) } : null; }
  async write(key: string, bytes: Buffer, expected: string | null) {
    this.writes.push({ key, expected });
    await this.onWrite?.(key, bytes);
    const existing = this.values.get(key);
    if (expected === null ? Boolean(existing) : existing?.etag !== expected) return false;
    this.values.set(key, { bytes: Buffer.from(bytes), etag: `etag-${++this.version}` }); return true;
  }
}

const setup = async () => {
  const storage = new MemoryStorage(); const clock = { value: 1_000 }; let leaseNumber = 0;
  const deps = { storage, now: () => clock.value, newLeaseId: () => `lease-${++leaseNumber}` };
  await storage.write(manifest.representativeBundle.key, jpeg, null);
  await storage.write(preparation.manifestKey, manifestBytes, null);
  const start = await startVideoIntelligenceJob(identity, deps);
  await checkpointVideoIntelligenceJob(identity, start.job.lease!.id, (job) => ({ ...job, phase: 'TRANSCRIBING', preparation, lease: null }), deps);
  const transcriptClaim = await claimVideoIntelligenceJob(identity, deps);
  if (transcriptClaim.status !== 'WORK') throw new Error('Expected transcription claim.');
  await checkpointVideoIntelligenceJob(identity, transcriptClaim.leaseId, (job) => ({ ...job, phase: 'OBSERVING', lease: null,
    transcript: { version: 1, model: 'whisper-1', sourceVideoMediaId: mediaId, sourceVideoContentHash: identity.sourceVideoContentHash,
      language: 'en', segments: [{ segmentIndex: 0, startMs: 0, endMs: 1_000, text: 'Fixture speech.' }] } }), deps);
  const observationClaim = await claimVideoIntelligenceJob(identity, deps);
  if (observationClaim.status !== 'WORK') throw new Error('Expected observation claim.');
  await checkpointVideoIntelligenceJob(identity, observationClaim.leaseId, (job) => ({ ...job, phase: 'FINALIZING', lease: null,
    representatives: [{ candidateIndex: 0, frameSha256: candidate.frameSha256, thumbnail, observation }] }), deps);
  const finalClaim = await claimVideoIntelligenceJob(identity, deps);
  if (finalClaim.status !== 'WORK') throw new Error('Expected finalization claim.');
  return { deps, storage, clock, work: finalClaim };
};

describe('durable video library finalization', () => {
  it('assembles through real preparation/store helpers and round-trips a source-bound library', async () => {
    const { deps, storage, work } = await setup();
    const complete = await runVideoIntelligenceFinalizationJob(identity, work.leaseId, deps);
    expect(complete).toMatchObject({ phase: 'COMPLETE', lease: null, providerEligible: false });
    const library = await loadVideoIntelligenceLibrary(identity, complete.result!, { storage });
    expect(library).toMatchObject({ id: `video-library:${sha(`${mediaId}:${identity.sourceVideoContentHash}`)}`,
      providerEligible: false, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', sourceVideoMediaId: mediaId,
      representativeFrames: [{ frameSha256: candidate.frameSha256, thumbnailDataUrl: thumbnail.thumbnailDataUrl,
        transcriptSegments: [{ text: 'Fixture speech.' }] }] });
    expect((await readVideoIntelligenceJob(identity, deps))?.job.result).toEqual(complete.result);
    expect(storage.writes.filter(({ key }) => key.startsWith('libraries/'))).toEqual([{ key: complete.result!.key, expected: null }]);
  });

  it('reuses the immutable artifact after a failed job checkpoint without overwriting it', async () => {
    const { deps, storage, work } = await setup(); const failure = new Error('checkpoint unavailable');
    storage.onWrite = async (key, bytes) => { if (key.startsWith('jobs/') && JSON.parse(bytes.toString()).phase === 'COMPLETE') throw failure; };
    await expect(runVideoIntelligenceFinalizationJob(identity, work.leaseId, deps)).rejects.toBe(failure);
    expect((await readVideoIntelligenceJob(identity, deps))?.job.phase).toBe('FINALIZING');
    const artifacts = [...storage.values.keys()].filter((key) => key.startsWith('libraries/'));
    expect(artifacts).toHaveLength(1);
    const artifactEtag = storage.values.get(artifacts[0])!.etag;
    storage.onWrite = undefined;
    expect((await runVideoIntelligenceFinalizationJob(identity, work.leaseId, deps)).phase).toBe('COMPLETE');
    expect(storage.values.get(artifacts[0])!.etag).toBe(artifactEtag);
  });

  it('rejects stale ownership and preserves a replacement lease acquired during artifact persistence', async () => {
    const { deps, storage, clock, work } = await setup();
    await expect(runVideoIntelligenceFinalizationJob(identity, 'stale', deps)).rejects.toBeInstanceOf(VideoIntelligenceJobLeaseLostError);
    storage.onWrite = async (key) => {
      if (key.startsWith('libraries/')) { clock.value = work.job.lease!.expiresAtMs; await claimVideoIntelligenceJob(identity, deps); }
    };
    await expect(runVideoIntelligenceFinalizationJob(identity, work.leaseId, deps)).rejects.toBeInstanceOf(VideoIntelligenceJobLeaseLostError);
    const current = (await readVideoIntelligenceJob(identity, deps))!.job;
    expect(current.phase).toBe('FINALIZING'); expect(current.lease!.id).not.toBe(work.leaseId); expect(current.result).toBeUndefined();
  });

  it('rejects corrupt artifacts, mismatched analyzer identity, and oversized references', async () => {
    const { deps, storage, work } = await setup();
    const complete = await runVideoIntelligenceFinalizationJob(identity, work.leaseId, deps); const reference = complete.result!;
    const otherIdentity = { ...identity, analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'other-model') };
    await expect(loadVideoIntelligenceLibrary(otherIdentity, reference, { storage })).rejects.toThrow('source and analyzer');
    await expect(loadVideoIntelligenceLibrary(identity, { ...reference, byteLength: MAX_VIDEO_INTELLIGENCE_LIBRARY_BYTES + 1 }, { storage })).rejects.toThrow('reference');
    storage.values.get(reference.key)!.bytes[0] ^= 1;
    await expect(loadVideoIntelligenceLibrary(identity, reference, { storage })).rejects.toThrow('missing or corrupt');
  });

  it('rejects frame drift before persisting and never replaces a conflicting immutable artifact', async () => {
    const drift = await setup();
    const stored = (await readVideoIntelligenceJob(identity, drift.deps))!;
    const entry = stored.job.representatives[0];
    entry.frameSha256 = entry.thumbnail!.frameSha256 = entry.observation!.frameSha256 = sha('different-frame');
    await drift.storage.write(videoIntelligenceJobKey(identity), Buffer.from(JSON.stringify(stored.job)), stored.etag);
    await expect(runVideoIntelligenceFinalizationJob(identity, drift.work.leaseId, drift.deps)).rejects.toThrow('thumbnail');
    expect(drift.storage.writes.some(({ key }) => key.startsWith('libraries/'))).toBe(false);

    const first = await setup();
    const complete = await runVideoIntelligenceFinalizationJob(identity, first.work.leaseId, first.deps);
    const collision = await setup(); const badBytes = Buffer.from('corrupt artifact');
    await collision.storage.write(complete.result!.key, badBytes, null);
    await expect(runVideoIntelligenceFinalizationJob(identity, collision.work.leaseId, collision.deps)).rejects.toThrow('collision');
    expect(collision.storage.values.get(complete.result!.key)!.bytes).toEqual(badBytes);
    expect((await readVideoIntelligenceJob(identity, collision.deps))?.job.phase).toBe('FINALIZING');
  });
});
