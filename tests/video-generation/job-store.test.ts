import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaStorage } from '@/lib/media/storage';
import type { StoredCreativeSourceMediaFile } from '@/lib/media/types';
import { claimVideoGenerationSubmission, createVideoGenerationJob, readVideoGenerationJob,
  settleVideoGenerationSubmission, type VideoGenerationIntent } from '@/lib/video-generation/job-store';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';
import { REAL_ENCODED_MP4 } from '../fixtures/media';

const identity = { operatorId: 'operator-a', submissionId: '11111111-1111-4111-8111-111111111111' };
const imageId = `media_${'a'.repeat(32)}`, videoId = `media_${'b'.repeat(32)}`;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const providerJob = { requestId: '22222222-2222-4222-8222-222222222222', status: 'queued' as const,
  statusUrl: 'https://api.higgsfield.ai/requests/22222222-2222-4222-8222-222222222222/status', videoUrl: null };
const intent = (): VideoGenerationIntent => ({ brief: { version: 1, script: 'Explain the consultation.', durationSeconds: 10,
  placement: 'VERTICAL_9_16', aspectRatio: '9:16', sources: [
    { reference: 'image', mediaId: imageId, role: 'TRA_REFERENCE', mediaType: 'IMAGE', purpose: 'HUMAN_IDENTITY', permissionReference: 'likeness:1' },
    { reference: 'motion', mediaId: videoId, role: 'TRA_VIDEO', mediaType: 'VIDEO', purpose: 'CONTENT', permissionReference: 'motion:1' },
  ], shots: [{ durationSeconds: 10, description: 'Explain naturally.', subject: 'SOURCE_HUMAN', humanSourceReference: 'image', sourceReferences: ['image', 'motion'] }],
  evidenceReferences: [], claims: [], disclaimers: [], voiceSourceReference: null, approval: 'APPROVED', provider: null, quotedCost: null },
  imageReference: 'image', motionVideoReference: 'motion', prompt: 'Natural motion', characterOrientation: 'video', keepOriginalSound: false,
  admission: { authorizationReference: 'budget:1', permissionReference: 'inputs:1', quoteReference: 'quote:1', quotedCostUsd: 0.35, maxCostUsd: 0.5 } });
const setup = () => {
  const storage = new MemoryPortfolioStorage();
  const saved: Record<string, StoredCreativeSourceMediaFile> = {
    [imageId]: { fileName: `${imageId}.png`, buffer: png, mimeType: 'image/png', mediaType: 'IMAGE' },
    [videoId]: { fileName: `${videoId}.mp4`, buffer: Buffer.from(REAL_ENCODED_MP4), mimeType: 'video/mp4', mediaType: 'VIDEO' },
  };
  const readMediaById = vi.fn(async (id: string) => saved[id] ?? null);
  const media = { readMediaById } as unknown as MediaStorage;
  const deps = { storage, now: () => 100 };
  return { storage, saved, media, readMediaById, deps,
    create: (value = intent(), owner = identity) => createVideoGenerationJob(owner, value, media, deps) };
};
afterEach(() => vi.unstubAllGlobals());

describe('offline durable motion-control submissions', () => {
  it('binds saved bytes and explicit permission evidence, with persistent creative identity and zero provider calls', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const s = setup(); const job = await s.create();
    expect(job.sources[0]).toMatchObject({ mediaId: imageId, permissionReference: 'likeness:1',
      sha256: createHash('sha256').update(png).digest('hex') });
    expect(job.sources[1]).toMatchObject({ mediaId: videoId, mediaType: 'VIDEO', permissionReference: 'motion:1',
      sha256: createHash('sha256').update(Buffer.from(REAL_ENCODED_MP4)).digest('hex') });
    expect(job.creativeId).toMatch(/^creative_[a-f0-9]{32}$/);
    expect(job.phase).toBe('PREPARED'); expect(job.providerJob).toBeNull();
    expect(JSON.stringify(job)).not.toContain('/api/media/'); expect(fetch).not.toHaveBeenCalled();
    expect(await readVideoGenerationJob(identity, s.storage)).toEqual(job);
    await claimVideoGenerationSubmission(identity, s.deps); expect(fetch).not.toHaveBeenCalled();
  });
  it('replays stored authority before mutable source reads and rejects changed intent or admission', async () => {
    const s = setup(), input = intent(), first = await s.create(input); delete s.saved[imageId];
    expect(await s.create(input)).toEqual(first); expect(s.readMediaById).toHaveBeenCalledTimes(2);
    await expect(s.create({ ...input, prompt: 'Changed' })).rejects.toThrow('inputs changed');
    await expect(s.create({ ...input, admission: { ...input.admission!, maxCostUsd: 1 } })).rejects.toThrow('inputs changed');
  });
  it('separates operators and submission intents while reconciling concurrent fresh creation', async () => {
    const s = setup(); const jobs = await Promise.all([s.create(), s.create()]); expect(jobs[0]).toEqual(jobs[1]);
    expect((await s.create(intent(), { ...identity, operatorId: 'operator-b' })).id).not.toBe(jobs[0].id);
    expect((await s.create(intent(), { ...identity, submissionId: '33333333-3333-4333-8333-333333333333' })).creativeId).not.toBe(jobs[0].creativeId);
  });
  it.each(['missing', 'wrong-type', 'invalid-bytes'] as const)('rejects %s authoritative media before storing a job', async failure => {
    const s = setup();
    if (failure === 'missing') delete s.saved[imageId];
    else if (failure === 'wrong-type') s.saved[imageId] = s.saved[videoId];
    else s.saved[imageId] = { ...s.saved[imageId], buffer: Buffer.from('invalid') };
    await expect(s.create()).rejects.toThrow(); expect(await readVideoGenerationJob(identity, s.storage)).toBeNull();
  });
  it.each(['approval', 'permission', 'reference', 'quote'] as const)('rejects invalid %s without media access', async failure => {
    const s = setup(), value = intent();
    if (failure === 'approval') value.brief.approval = 'PENDING';
    if (failure === 'permission') value.brief.sources[0].permissionReference = null;
    if (failure === 'reference') value.motionVideoReference = 'absent';
    if (failure === 'quote') value.admission!.quotedCostUsd = 1;
    await expect(s.create(value)).rejects.toThrow(); expect(s.readMediaById).not.toHaveBeenCalled();
  });
  it('prepares without paid admission but cannot claim or silently add admission on replay', async () => {
    const s = setup(); await s.create({ ...intent(), admission: null });
    await expect(claimVideoGenerationSubmission(identity, s.deps)).rejects.toThrow('admission');
    await expect(s.create()).rejects.toThrow('inputs changed');
  });
  it('grants exactly one concurrent claim and never reclaims an interrupted submission', async () => {
    const s = setup(), initial = await s.create();
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimVideoGenerationSubmission(identity, s.deps)));
    expect(claims.filter(claim => claim.status === 'CLAIMED')).toHaveLength(1);
    expect(claims.filter(claim => claim.status === 'CURRENT')).toHaveLength(7);
    const later = await claimVideoGenerationSubmission(identity, { ...s.deps, now: () => 100_000_000 });
    expect(later.status).toBe('CURRENT'); expect(later.job.phase).toBe('SUBMITTING');
    expect(later.job.creativeId).toBe(initial.creativeId); expect(later.job.intent).toEqual(initial.intent);
  });
  it('preserves unknown purchase state and accepts only the same token late receipt without another claim', async () => {
    const s = setup(); await s.create(); const claim = await claimVideoGenerationSubmission(identity, s.deps);
    if (claim.status !== 'CLAIMED') throw new Error('Missing claim');
    await expect(settleVideoGenerationSubmission(identity, 'stale', { status: 'ACCEPTED', providerJob }, s.deps)).rejects.toThrow('token');
    await settleVideoGenerationSubmission(identity, claim.token, { status: 'UNKNOWN' }, s.deps);
    expect((await claimVideoGenerationSubmission(identity, s.deps)).status).toBe('CURRENT');
    const accepted = await settleVideoGenerationSubmission(identity, claim.token, { status: 'ACCEPTED', providerJob }, s.deps);
    expect(await settleVideoGenerationSubmission(identity, claim.token, { status: 'ACCEPTED', providerJob }, s.deps)).toEqual(accepted);
    await expect(settleVideoGenerationSubmission(identity, claim.token, { status: 'UNKNOWN' }, s.deps)).rejects.toThrow('settled');
    await expect(settleVideoGenerationSubmission(identity, claim.token, { status: 'ACCEPTED', providerJob: { ...providerJob,
      requestId: '44444444-4444-4444-8444-444444444444' } }, s.deps)).rejects.toThrow('settled');
    expect(accepted.sources).toEqual(claim.job.sources); expect(accepted.creativeId).toBe(claim.job.creativeId);
  });
  it('keeps a failed claim write unclaimed and a failed receipt write unresolved', async () => {
    const s = setup(); await s.create(); const write = vi.spyOn(s.storage, 'write');
    write.mockRejectedValueOnce(new Error('storage down'));
    await expect(claimVideoGenerationSubmission(identity, s.deps)).rejects.toThrow('storage down');
    expect((await readVideoGenerationJob(identity, s.storage))?.phase).toBe('PREPARED');
    const claim = await claimVideoGenerationSubmission(identity, s.deps); if (claim.status !== 'CLAIMED') throw new Error('Missing claim');
    write.mockRejectedValueOnce(new Error('storage down'));
    await expect(settleVideoGenerationSubmission(identity, claim.token, { status: 'ACCEPTED', providerJob }, s.deps)).rejects.toThrow('storage down');
    expect((await claimVideoGenerationSubmission(identity, s.deps)).job.phase).toBe('SUBMITTING');
    expect((await settleVideoGenerationSubmission(identity, claim.token, { status: 'ACCEPTED', providerJob }, s.deps)).phase).toBe('ACCEPTED');
  });
  it('records a confirmed rejection without opening a retry and rejects malformed acceptance', async () => {
    const s = setup(); await s.create(); const claim = await claimVideoGenerationSubmission(identity, s.deps);
    if (claim.status !== 'CLAIMED') throw new Error('Missing claim');
    await expect(settleVideoGenerationSubmission(identity, claim.token, { status: 'ACCEPTED', providerJob: { ...providerJob, statusUrl: 'https://wrong.example/' } }, s.deps)).rejects.toThrow('inconsistent');
    const rejected = await settleVideoGenerationSubmission(identity, claim.token, { status: 'REJECTED', httpStatus: 422 }, s.deps);
    expect(rejected.rejectionHttpStatus).toBe(422); expect((await claimVideoGenerationSubmission(identity, s.deps)).status).toBe('CURRENT');
  });
  it('fails closed on persistent CAS contention and unreadable saved state', async () => {
    const s = setup(); await s.create(); const write = vi.spyOn(s.storage, 'write').mockResolvedValue(false);
    await expect(claimVideoGenerationSubmission(identity, s.deps)).rejects.toThrow('concurrently');
    expect((await readVideoGenerationJob(identity, s.storage))?.phase).toBe('PREPARED'); write.mockRestore();
    const path = [...s.storage.data.keys()][0]; s.storage.data.set(path, { bytes: Buffer.from('{broken'), etag: '2' });
    await expect(s.create()).rejects.toThrow('inconsistent');
    expect(s.readMediaById).toHaveBeenCalledTimes(2);
  });
});
