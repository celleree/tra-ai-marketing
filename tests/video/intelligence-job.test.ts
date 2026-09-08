import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import {
  MAX_VIDEO_INTELLIGENCE_JOB_BYTES,
  VIDEO_INTELLIGENCE_JOB_LEASE_MS,
  parseVideoIntelligenceJob,
  videoIntelligenceJobId,
  videoIntelligenceJobKey,
  type VideoIntelligenceJob,
} from '@/lib/video/intelligence-job';
import { createVideoIntelligenceAnalyzerFingerprint } from '@/lib/video/intelligence-preparation';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const mediaId = `media_${'a'.repeat(32)}`;
const contentHash = hash('source');
const fingerprint = createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'vision-model');
const identity = { sourceVideoMediaId: mediaId, sourceVideoContentHash: contentHash, analyzerFingerprint: fingerprint };
const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#663399' } }).jpeg().toBuffer();
const frameHash = hash('frame');
const thumbnail = { sourceVideoMediaId: mediaId, sourceVideoContentHash: contentHash, candidateIndex: 1,
  timestampMs: 500, frameSha256: frameHash, thumbnailDataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` };
const observation = { version: 1 as const, model: 'vision-model', providerEligible: false as const,
  evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const, sourceVideoMediaId: mediaId,
  sourceVideoContentHash: contentHash, candidateIndex: 1, timestampMs: 500, frameSha256: frameHash,
  observation: { sceneType: 'OTHER' as const, summary: 'Frame.', composition: 'Full frame.', visibleText: [], topics: ['other' as const], uncertainties: [] } };

const baseJob = (): VideoIntelligenceJob => ({
  version: 1, artifactType: 'VIDEO_INTELLIGENCE_JOB', providerEligible: false,
  id: videoIntelligenceJobId(identity), sourceVideoMediaId: mediaId, sourceVideoContentHash: contentHash,
  analyzerFingerprint: structuredClone(fingerprint), phase: 'PREPARING', representatives: [], lease: null,
  createdAtMs: 1_000, updatedAtMs: 1_000,
});
const preparation = { manifestKey: `preparations/manifests/sha256/${hash('manifest')}.json`,
  manifestSha256: hash('manifest'), durationMs: 2_000, representativeCandidateIndexes: [1] };
const transcript = { version: 1 as const, model: 'whisper-1' as const, sourceVideoMediaId: mediaId,
  sourceVideoContentHash: contentHash, language: 'en', segments: [{ segmentIndex: 0, startMs: 0, endMs: 1_000, text: 'Speech.' }] };
const parse = (job: VideoIntelligenceJob) => parseVideoIntelligenceJob(Buffer.from(JSON.stringify(job)), identity);
const completeProgress = () => [{ candidateIndex: 1, frameSha256: frameHash, thumbnail, observation }];

describe('video intelligence job contract', () => {
  it('derives stable source-and-analyzer-bound identities', () => {
    expect(videoIntelligenceJobKey(identity)).toMatch(/^jobs\/sha256\/[a-f0-9]{64}\.json$/);
    expect(videoIntelligenceJobKey(identity)).toBe(videoIntelligenceJobKey(structuredClone(identity)));
    expect(videoIntelligenceJobKey({ ...identity, sourceVideoContentHash: hash('other') })).not.toBe(videoIntelligenceJobKey(identity));
    const otherFingerprint = createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'other-model');
    expect(videoIntelligenceJobId({ ...identity, analyzerFingerprint: otherFingerprint })).not.toBe(videoIntelligenceJobId(identity));
  });

  it.each([
    baseJob(),
    { ...baseJob(), phase: 'TRANSCRIBING' as const, preparation },
    { ...baseJob(), phase: 'OBSERVING' as const, preparation, transcript,
      representatives: [{ candidateIndex: 1, frameSha256: frameHash, thumbnail }] },
    { ...baseJob(), phase: 'FINALIZING' as const, preparation, transcript, representatives: completeProgress() },
    { ...baseJob(), phase: 'COMPLETE' as const, preparation, transcript, representatives: completeProgress(),
      result: { key: `libraries/sha256/${hash('library')}.json`, sha256: hash('library'), byteLength: 100 } },
    { ...baseJob(), phase: 'FAILED' as const, failure: { phase: 'PREPARING' as const, message: 'Invalid input.' } },
    { ...baseJob(), phase: 'RETRY_REQUIRED' as const, preparation, retry: {
      phase: 'TRANSCRIBING' as const, reason: 'PAID_WORK_FAILED' as const, message: 'Provider failed.' } },
    { ...baseJob(), phase: 'RETRY_REQUIRED' as const, preparation, transcript,
      representatives: [{ candidateIndex: 1, frameSha256: frameHash, thumbnail }],
      retry: { phase: 'OBSERVING' as const, candidateIndexes: [1] as [number], reason: 'LEASE_EXPIRED' as const } },
    { ...baseJob(), phase: 'OBSERVING' as const, preparation: { ...preparation, durationMs: 2_000.5 },
      transcript: { ...transcript, segments: [{ ...transcript.segments[0], endMs: 2_000.5 }] } },
  ])('accepts a valid $phase state', (job) => expect(parse(job)).toEqual(job));

  it('accepts a five-minute work lease with at most two source representatives', () => {
    const job = { ...baseJob(), phase: 'OBSERVING' as const, preparation: { ...preparation, representativeCandidateIndexes: [1, 3] }, transcript,
      lease: { id: 'lease-1', phase: 'OBSERVING' as const, candidateIndexes: [1, 3] as [number, number],
        acquiredAtMs: 2_000, expiresAtMs: 2_000 + VIDEO_INTELLIGENCE_JOB_LEASE_MS } };
    expect(parse(job).lease).toEqual(job.lease);
  });

  it.each([
    ['foreign source', (job: VideoIntelligenceJob) => { job.sourceVideoContentHash = hash('foreign'); }],
    ['changed fingerprint', (job: VideoIntelligenceJob) => { job.analyzerFingerprint.sha256 = hash('fake'); }],
    ['duplicate indexes', (job: VideoIntelligenceJob) => { job.phase = 'TRANSCRIBING'; job.preparation = { ...preparation, representativeCandidateIndexes: [1, 1] }; }],
    ['out-of-range timestamp', (job: VideoIntelligenceJob) => { job.phase = 'OBSERVING'; job.preparation = preparation; job.transcript = transcript; job.representatives = [{ candidateIndex: 1, frameSha256: frameHash, thumbnail: { ...thumbnail, timestampMs: 2_000 } }]; }],
    ['observation without thumbnail', (job: VideoIntelligenceJob) => { job.phase = 'OBSERVING'; job.preparation = preparation; job.transcript = transcript; job.representatives = [{ candidateIndex: 1, frameSha256: frameHash, observation }]; }],
    ['observation model drift', (job: VideoIntelligenceJob) => { job.phase = 'OBSERVING'; job.preparation = preparation; job.transcript = transcript; job.representatives = [{ candidateIndex: 1, frameSha256: frameHash, thumbnail, observation: { ...observation, model: 'other' } }]; }],
    ['early finalization', (job: VideoIntelligenceJob) => { job.phase = 'FINALIZING'; job.preparation = preparation; job.transcript = transcript; }],
    ['result before complete', (job: VideoIntelligenceJob) => { job.result = { key: `libraries/sha256/${hash('library')}.json`, sha256: hash('library'), byteLength: 1 }; }],
    ['wrong lease duration', (job: VideoIntelligenceJob) => { job.lease = { id: 'lease', phase: 'PREPARING', acquiredAtMs: 1, expiresAtMs: 2 }; }],
    ['missing lease field', (job: VideoIntelligenceJob) => { delete (job as Partial<VideoIntelligenceJob>).lease; }],
    ['oversized pair', (job: VideoIntelligenceJob) => { job.phase = 'OBSERVING'; job.preparation = { ...preparation, representativeCandidateIndexes: [1, 2, 3] }; job.transcript = transcript; job.lease = { id: 'lease', phase: 'OBSERVING', candidateIndexes: [1, 2, 3] as unknown as [number], acquiredAtMs: 1, expiresAtMs: 1 + VIDEO_INTELLIGENCE_JOB_LEASE_MS }; }],
    ['transcription retry after transcript', (job: VideoIntelligenceJob) => { job.phase = 'RETRY_REQUIRED'; job.preparation = preparation; job.transcript = transcript; job.retry = { phase: 'TRANSCRIBING', reason: 'PAID_WORK_FAILED' }; }],
    ['observation retry before transcript', (job: VideoIntelligenceJob) => { job.phase = 'RETRY_REQUIRED'; job.preparation = preparation; job.retry = { phase: 'OBSERVING', candidateIndexes: [1], reason: 'PAID_WORK_FAILED' }; }],
  ])('rejects malformed persisted data: %s', (_name, mutate) => {
    const job = baseJob(); mutate(job); expect(() => parse(job)).toThrow('job rejected');
  });

  it('rejects invalid JSON and serialized jobs above the 32 MiB cap', () => {
    expect(() => parseVideoIntelligenceJob(Buffer.from('{'), identity)).toThrow('JSON');
    expect(() => parseVideoIntelligenceJob(Buffer.alloc(MAX_VIDEO_INTELLIGENCE_JOB_BYTES + 1), identity)).toThrow('size');
  });
});
