import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseSubmissionId, SubmissionConflictError } from '@/lib/creatives/submission-id';
import { hydrateCreativeSourceSelections } from '@/lib/media/source-hydration';
import type { MediaStorage } from '@/lib/media/storage';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { parseVideoCreativeBrief, type VideoCreativeBrief } from '@/lib/video-generation/brief';
import { HIGGSFIELD_MOTION_MODEL, type HiggsfieldJob, type MotionControlAdmission } from '@/lib/video-generation/higgsfield';

type Admission = Omit<MotionControlAdmission, 'idempotencyKey'>;
export type VideoGenerationIntent = {
  brief: VideoCreativeBrief; imageReference: string; motionVideoReference: string;
  prompt: string; characterOrientation: 'image' | 'video'; keepOriginalSound: boolean;
  admission: Admission | null;
};
export type VideoGenerationIdentity = { operatorId: string; submissionId: string };
type SourceBinding = { reference: string; mediaId: string; role: 'TRA_REFERENCE' | 'TRA_VIDEO';
  mediaType: 'IMAGE' | 'VIDEO'; sha256: string; permissionReference: string };
export type VideoGenerationJob = {
  version: 1; id: string; creativeId: string; operatorHash: string; submissionId: string;
  model: typeof HIGGSFIELD_MOTION_MODEL; intent: VideoGenerationIntent; sources: SourceBinding[];
  phase: 'PREPARED' | 'SUBMITTING' | 'UNKNOWN' | 'ACCEPTED' | 'REJECTED';
  attemptToken: string | null; providerJob: HiggsfieldJob | null; rejectionHttpStatus: number | null;
  createdAtMs: number; updatedAtMs: number;
};
type Dependencies = { storage?: VideoIntelligenceStorage; now?: () => number; newToken?: () => string };
type Stored = { job: VideoGenerationJob; etag: string };
export type VideoGenerationSettlement = { status: 'ACCEPTED'; providerJob: HiggsfieldJob }
  | { status: 'UNKNOWN' } | { status: 'REJECTED'; httpStatus: number };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const text = (value: unknown, max = 2000): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const unavailable = (): never => { throw new Error('Video generation job state is unavailable or inconsistent.'); };
const validAdmission = (value: Admission | null) => value === null || (value
  && [value.authorizationReference, value.permissionReference, value.quoteReference].every(item => text(item))
  && Number.isFinite(value.quotedCostUsd) && value.quotedCostUsd > 0
  && Number.isFinite(value.maxCostUsd) && value.maxCostUsd >= value.quotedCostUsd);
const identityFor = (identity: VideoGenerationIdentity) => {
  const submissionId = parseSubmissionId(identity.submissionId);
  if (!text(identity.operatorId, 1000) || !submissionId) throw new SubmissionConflictError('Invalid video submission identity.');
  const operatorHash = hash(identity.operatorId);
  const suffix = hash(JSON.stringify([operatorHash, submissionId])).slice(0, 32);
  return { id: `videojob_${suffix}`, creativeId: `creative_${suffix}`, operatorHash, submissionId };
};
const key = (id: string) => `video-generation-jobs/v1/${id}.json`;
const selectedSources = (intent: VideoGenerationIntent) => {
  const image = intent.brief.sources.find(source => source.reference === intent.imageReference);
  const video = intent.brief.sources.find(source => source.reference === intent.motionVideoReference);
  if (!image || !video || image.role !== 'TRA_REFERENCE' || image.mediaType !== 'IMAGE'
    || !['CONTENT', 'HUMAN_IDENTITY'].includes(image.purpose)
    || video.role !== 'TRA_VIDEO' || video.mediaType !== 'VIDEO'
    || !text(image.permissionReference) || !text(video.permissionReference)) {
    throw new Error('Motion control requires saved TRA image/video sources with explicit permission evidence.');
  }
  return [image, video];
};
const normalizeIntent = (input: VideoGenerationIntent): VideoGenerationIntent => {
  const brief = parseVideoCreativeBrief(input.brief);
  if (!brief || brief.approval !== 'APPROVED' || !text(input.imageReference, 12000) || !text(input.motionVideoReference, 12000)
    || typeof input.prompt !== 'string' || input.prompt.length > 12000
    || !['image', 'video'].includes(input.characterOrientation) || typeof input.keepOriginalSound !== 'boolean'
    || !validAdmission(input.admission)) throw new Error('Video generation intent is invalid.');
  const intent = { brief, imageReference: input.imageReference, motionVideoReference: input.motionVideoReference,
    prompt: input.prompt, characterOrientation: input.characterOrientation, keepOriginalSound: input.keepOriginalSound,
    admission: input.admission === null ? null : {
      authorizationReference: input.admission.authorizationReference, permissionReference: input.admission.permissionReference,
      quoteReference: input.admission.quoteReference, quotedCostUsd: input.admission.quotedCostUsd, maxCostUsd: input.admission.maxCostUsd,
    } };
  selectedSources(intent); return intent;
};
const validProviderJob = (job: HiggsfieldJob) => {
  if (!job || !parseSubmissionId(job.requestId) || !['queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled'].includes(job.status)) return false;
  const expectedUrl = `https://api.higgsfield.ai/requests/${job.requestId}/status`;
  if (job.statusUrl !== null && job.statusUrl !== expectedUrl) return false;
  if (['queued', 'in_progress'].includes(job.status) && job.statusUrl !== expectedUrl) return false;
  if (job.status !== 'completed') return job.videoUrl === null;
  try { const url = new URL(job.videoUrl!); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
};
const parse = (bytes: Buffer, expected: ReturnType<typeof identityFor>): VideoGenerationJob => {
  try {
    if (bytes.length > 512 * 1024) return unavailable();
    const job = JSON.parse(bytes.toString()) as VideoGenerationJob;
    if (!job || job.version !== 1 || job.model !== HIGGSFIELD_MOTION_MODEL
      || Object.entries(expected).some(([name, value]) => job[name as keyof VideoGenerationJob] !== value)
      || !isDeepStrictEqual(job.intent, normalizeIntent(job.intent)) || !Array.isArray(job.sources) || job.sources.length !== 2
      || !Number.isSafeInteger(job.createdAtMs) || !Number.isSafeInteger(job.updatedAtMs) || job.createdAtMs < 0 || job.updatedAtMs < job.createdAtMs) return unavailable();
    const selected = selectedSources(job.intent);
    if (job.sources.some((source, index) => !source || !/^[a-f0-9]{64}$/.test(source.sha256)
      || ['reference', 'mediaId', 'role', 'mediaType', 'permissionReference'].some(name =>
        source[name as keyof SourceBinding] !== selected[index][name as keyof typeof selected[number]]))) return unavailable();
    if (!['PREPARED', 'SUBMITTING', 'UNKNOWN', 'ACCEPTED', 'REJECTED'].includes(job.phase)
      || (job.phase === 'PREPARED' ? job.attemptToken !== null : !parseSubmissionId(job.attemptToken))
      || (job.phase !== 'PREPARED' && job.intent.admission === null)
      || (job.phase === 'ACCEPTED' ? !validProviderJob(job.providerJob!) : job.providerJob !== null)
      || (job.phase === 'REJECTED' ? !Number.isInteger(job.rejectionHttpStatus) || job.rejectionHttpStatus! < 400
        || job.rejectionHttpStatus! > 499 : job.rejectionHttpStatus !== null)) return unavailable();
    return job;
  } catch { return unavailable(); }
};
const read = async (expected: ReturnType<typeof identityFor>, storage: VideoIntelligenceStorage): Promise<Stored | null> => {
  const stored = await storage.read(key(expected.id));
  return stored && { job: parse(stored.bytes, expected), etag: stored.etag };
};
const write = (job: VideoGenerationJob, storage: VideoIntelligenceStorage, etag: string | null) => {
  const bytes = Buffer.from(JSON.stringify(job));
  parse(bytes, { id: job.id, creativeId: job.creativeId, operatorHash: job.operatorHash, submissionId: job.submissionId });
  return storage.write(key(job.id), bytes, etag);
};

export async function readVideoGenerationJob(identity: VideoGenerationIdentity, storage = getVideoIntelligenceStorage()) {
  return (await read(identityFor(identity), storage))?.job ?? null;
}

/** Offline preparation only: approval and permission references record caller evidence, never verify execution rights. */
export async function createVideoGenerationJob(identity: VideoGenerationIdentity, input: VideoGenerationIntent,
  mediaStorage: MediaStorage, dependencies: Dependencies = {}) {
  const expected = identityFor(identity), intent = normalizeIntent(input);
  const storage = dependencies.storage ?? getVideoIntelligenceStorage();
  const reconcile = (job: VideoGenerationJob) => {
    if (!isDeepStrictEqual(job.intent, intent)) throw new SubmissionConflictError('Video submission inputs changed. Start a new intentional job.');
    return job;
  };
  const existing = await read(expected, storage);
  if (existing) return reconcile(existing.job);
  const selected = selectedSources(intent);
  const hydrated = await hydrateCreativeSourceSelections(mediaStorage, selected.map(source => ({ mediaId: source.mediaId, role: source.role })));
  const sources = selected.map((source, index): SourceBinding => ({ reference: source.reference, mediaId: source.mediaId,
    role: source.role as SourceBinding['role'], mediaType: source.mediaType, permissionReference: source.permissionReference!,
    sha256: hash(hydrated[index].stored.buffer) }));
  const now = (dependencies.now ?? Date.now)();
  const job: VideoGenerationJob = { version: 1, ...expected, model: HIGGSFIELD_MOTION_MODEL, intent, sources,
    phase: 'PREPARED', attemptToken: null, providerJob: null, rejectionHttpStatus: null, createdAtMs: now, updatedAtMs: now };
  if (await write(job, storage, null)) return job;
  const raced = await read(expected, storage);
  if (!raced) return unavailable();
  // A concurrent fresh preparation must not silently bind different source bytes.
  if (!isDeepStrictEqual(raced.job.sources, sources)) throw new SubmissionConflictError('Video sources changed during preparation.');
  return reconcile(raced.job);
}

async function change(identity: VideoGenerationIdentity, dependencies: Dependencies,
  update: (job: VideoGenerationJob) => VideoGenerationJob) {
  const expected = identityFor(identity), storage = dependencies.storage ?? getVideoIntelligenceStorage();
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await read(expected, storage);
    if (!current) throw new Error('Video generation job was not found.');
    const next = update(structuredClone(current.job));
    if (isDeepStrictEqual(next, current.job)) return { changed: false, job: current.job };
    next.updatedAtMs = Math.max(current.job.updatedAtMs, (dependencies.now ?? Date.now)());
    if (await write(next, storage, current.etag)) return { changed: true, job: next };
  }
  throw new Error('Video generation job changed concurrently. Reload before continuing.');
}

/** Only CLAIMED authorizes the future wrapper to make one POST, after this write succeeds.
 * Admission is caller evidence, not verified permission, account credit or an aggregate dollar cap.
 * Interrupted SUBMITTING/UNKNOWN is never reclaimed, irrespective of time or idempotency support. */
export async function claimVideoGenerationSubmission(identity: VideoGenerationIdentity, dependencies: Dependencies = {}) {
  const result = await change(identity, dependencies, job => {
    if (job.phase !== 'PREPARED') return job;
    if (job.intent.admission === null) throw new Error('Explicit video submission admission is required.');
    return { ...job, phase: 'SUBMITTING', attemptToken: (dependencies.newToken ?? randomUUID)() };
  });
  return result.changed ? { status: 'CLAIMED' as const, token: result.job.attemptToken!, job: result.job }
    : { status: 'CURRENT' as const, job: result.job };
}

/** A late same-token accepted receipt may reconcile UNKNOWN, never create another purchase.
 * REJECTED requires a confirmed rejection; timeout, malformed POST response or save failure stays unresolved. */
export async function settleVideoGenerationSubmission(identity: VideoGenerationIdentity, token: string,
  outcome: VideoGenerationSettlement, dependencies: Dependencies = {}) {
  return (await change(identity, dependencies, job => {
    if (job.attemptToken !== token || job.phase === 'PREPARED') throw new Error('Video submission token is no longer current.');
    const next: VideoGenerationJob = { ...job, phase: outcome.status,
      providerJob: outcome.status === 'ACCEPTED' ? structuredClone(outcome.providerJob) : null,
      rejectionHttpStatus: outcome.status === 'REJECTED' ? outcome.httpStatus : null };
    if (isDeepStrictEqual(next, job)) return job;
    if (!['SUBMITTING', 'UNKNOWN'].includes(job.phase)) throw new Error('Video submission is already settled.');
    return next;
  })).job;
}
