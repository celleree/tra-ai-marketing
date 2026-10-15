import { mkdir, readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ProofRecord, VideoPassageCandidate, VideoPassageCandidateLinkHealth, VideoPassageCandidateView } from '@/lib/proof/types';
import {
  isProofId,
  parseCaseStudyProofDraft,
  parseReviewProofDraft,
} from '@/lib/proof/validation';

const INDEX_KEY = '_metadata/proof-library.json';
const LOCAL_INDEX_PATH = resolve(process.cwd(), 'data', 'proof-library.json');
const SAVE_ATTEMPTS = 3;
const BASE_KEYS = ['id', 'type', 'tags', 'status', 'advertisingUseApproved', 'createdAt', 'updatedAt'];
const REVIEW_KEYS = [...BASE_KEYS, 'originalReviewText', 'source', 'attribution', 'rating'];
const CASE_STUDY_KEYS = [
  ...BASE_KEYS,
  'title',
  'verifiedFacts',
  'approvedClaimWording',
  'sourceNote',
  'usageRestrictions',
  'requiredDisclaimer',
];

type ProofLibraryIndex = { version: 1 | 2; items: ProofRecord[]; candidates: VideoPassageCandidate[] };
type IndexMutation<T> = (index: ProofLibraryIndex) => {
  index: ProofLibraryIndex;
  result: T;
  changed: boolean;
};

const emptyIndex = (): ProofLibraryIndex => ({ version: 1, items: [], candidates: [] });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const candidateId = (source: VideoPassageCandidate['source'], passage: Pick<VideoPassageCandidate['passage'], 'startSegmentIndex' | 'endSegmentIndex'>) =>
  `video-passage_${createHash('sha256').update(JSON.stringify([1, source.locator.version, source.locator.sourceVideoMediaId,
    source.locator.sourceVideoContentHash, source.locator.analyzerFingerprintSha256, source.library.id, source.library.version,
    passage.startSegmentIndex, passage.endSegmentIndex])).digest('hex')}`;
export const videoPassageCandidateId = candidateId;

const normalizeRecord = (value: unknown): ProofRecord | null => {
  if (!isRecord(value) || !isProofId(value.id)) return null;
  if (!Array.isArray(value.tags) || !isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)) {
    return null;
  }
  if (
    (value.status !== 'ACTIVE' && value.status !== 'INACTIVE') ||
    (value.advertisingUseApproved !== undefined && typeof value.advertisingUseApproved !== 'boolean') ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) {
    return null;
  }
  const base = {
    id: value.id,
    tags: value.tags,
    status: value.status,
    ...(typeof value.advertisingUseApproved === 'boolean'
      ? { advertisingUseApproved: value.advertisingUseApproved }
      : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  } as const;

  if (value.type === 'review' && hasOnly(value, REVIEW_KEYS)) {
    const draft = parseReviewProofDraft(value);
    return draft?.tags ? { ...base, type: 'review', ...draft, tags: draft.tags } : null;
  }
  if (value.type === 'case-study' && hasOnly(value, CASE_STUDY_KEYS)) {
    const draft = parseCaseStudyProofDraft(value);
    return draft?.tags
      ? { ...base, type: 'case-study', ...draft, tags: draft.tags }
      : null;
  }
  return null;
};

const normalizeCandidate = (value: unknown): VideoPassageCandidate | null => {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || !isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)
    || Date.parse(value.updatedAt) < Date.parse(value.createdAt) || !['PENDING', 'LINKED', 'DISMISSED'].includes(String(value.status))
    || !isRecord(value.source) || !isRecord(value.source.locator) || !isRecord(value.source.library) || !isRecord(value.passage)) return null;
  const { locator, library } = value.source;
  const passage = value.passage;
  const startSegmentIndex = typeof passage.startSegmentIndex === 'number' ? passage.startSegmentIndex : NaN;
  const endSegmentIndex = typeof passage.endSegmentIndex === 'number' ? passage.endSegmentIndex : NaN;
  const startMs = typeof passage.startMs === 'number' ? passage.startMs : NaN;
  const endMs = typeof passage.endMs === 'number' ? passage.endMs : NaN;
  const rawSegments = Array.isArray(passage.segments) ? passage.segments : null;
  if (!hasOnly(value, ['version', 'id', 'status', 'source', 'passage', 'link', 'createdAt', 'updatedAt'])
    || !hasOnly(value.source, ['locator', 'library']) || !hasOnly(locator, ['version', 'sourceVideoMediaId', 'sourceVideoContentHash', 'analyzerFingerprintSha256'])
    || !hasOnly(library, ['id', 'version']) || locator.version !== 1 || library.version !== 1
    || typeof locator.sourceVideoMediaId !== 'string' || !/^media_[a-f0-9]{32}$/.test(locator.sourceVideoMediaId)
    || !isHash(locator.sourceVideoContentHash) || !isHash(locator.analyzerFingerprintSha256)
    || library.id !== `video-library:${createHash('sha256').update(`${locator.sourceVideoMediaId}:${locator.sourceVideoContentHash}`).digest('hex')}`
    || !hasOnly(passage, ['startSegmentIndex', 'endSegmentIndex', 'startMs', 'endMs', 'segments'])
    || !Number.isSafeInteger(startSegmentIndex) || !Number.isSafeInteger(endSegmentIndex)
    || startSegmentIndex < 0 || endSegmentIndex < startSegmentIndex
    || !Number.isFinite(startMs) || !Number.isFinite(endMs) || !rawSegments
    || rawSegments.length !== endSegmentIndex - startSegmentIndex + 1) return null;
  const segments = rawSegments.map((segment) => isRecord(segment) && hasOnly(segment, ['segmentIndex', 'startMs', 'endMs', 'text'])
    && typeof segment.segmentIndex === 'number' && Number.isSafeInteger(segment.segmentIndex)
    && typeof segment.startMs === 'number' && Number.isFinite(segment.startMs)
    && typeof segment.endMs === 'number' && Number.isFinite(segment.endMs) && segment.endMs > segment.startMs
    && typeof segment.text === 'string' && Boolean(segment.text.trim()) ? segment : null);
  if (segments.some((segment) => !segment)) return null;
  const normalizedSegments = segments as VideoPassageCandidate['passage']['segments'];
  if (normalizedSegments.some((segment, index) => segment.segmentIndex !== startSegmentIndex + index)
    || normalizedSegments[0].startMs !== startMs || normalizedSegments.at(-1)!.endMs !== endMs) return null;
  const link = value.link === undefined ? undefined : value.link;
  if (link !== undefined && (!isRecord(link) || !hasOnly(link, ['proofId', 'proofType', 'proofUpdatedAt']) || !isProofId(link.proofId)
    || (link.proofType !== 'review' && link.proofType !== 'case-study') || !isIsoDate(link.proofUpdatedAt))) return null;
  const source = { locator: locator as VideoPassageCandidate['source']['locator'], library: library as VideoPassageCandidate['source']['library'] };
  const normalizedPassage = { startSegmentIndex, endSegmentIndex, startMs, endMs, segments: normalizedSegments };
  if (value.id !== candidateId(source, normalizedPassage) || (value.status === 'LINKED') !== Boolean(link)) return null;
  return { version: 1, id: value.id, status: value.status as VideoPassageCandidate['status'], source, passage: normalizedPassage,
    ...(link ? { link: link as VideoPassageCandidate['link'] } : {}), createdAt: value.createdAt, updatedAt: value.updatedAt };
};

const parseIndex = (raw: string): ProofLibraryIndex => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('Proof Library index contains malformed JSON.', { cause: error });
  }
  if (!isRecord(value) || !Array.isArray(value.items)
    || (value.version !== 1 && value.version !== 2)
    || (value.version === 1 && (!hasOnly(value, ['version', 'items']) || Object.keys(value).length !== 2))
    || (value.version === 2 && (!hasOnly(value, ['version', 'items', 'candidates']) || !isRecord(value.candidates)
      || value.candidates.version !== 1 || !Array.isArray(value.candidates.items) || !hasOnly(value.candidates, ['version', 'items'])))) {
    throw new Error('Proof Library index has an invalid schema.');
  }
  const items = value.items.map(normalizeRecord);
  if (items.some((item) => !item)) {
    throw new Error('Proof Library index contains an invalid record.');
  }
  const validItems = items as ProofRecord[];
  if (new Set(validItems.map(({ id }) => id)).size !== validItems.length) {
    throw new Error('Proof Library index contains duplicate proof IDs.');
  }
  const candidates = value.version === 2 ? (value.candidates as { items: unknown[] }).items.map(normalizeCandidate) : [];
  if (candidates.some((candidate) => !candidate) || new Set(candidates.map((candidate) => candidate!.id)).size !== candidates.length) {
    throw new Error('Proof Library index contains an invalid video passage candidate.');
  }
  return { version: value.version, items: validItems, candidates: candidates as VideoPassageCandidate[] };
};

const serializedIndex = (index: ProofLibraryIndex) => index.version === 1
  ? { version: 1, items: index.items }
  : { version: 2, items: index.items, candidates: { version: 1, items: index.candidates } };

const isMissing = (error: unknown) =>
  error instanceof NoSuchKey ||
  (isRecord(error) &&
    (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey' || error.code === 'NoSuchKey'));
const isLocalMissing = (error: unknown) => isRecord(error) && error.code === 'ENOENT';
const isWriteConflict = (error: unknown) =>
  isRecord(error) &&
  (error.name === 'PreconditionFailed' ||
    error.name === 'ConditionalRequestConflict' ||
    error.Code === 'PreconditionFailed' ||
    error.Code === 'ConditionalRequestConflict' ||
    (isRecord(error.$metadata) &&
      (error.$metadata.httpStatusCode === 409 || error.$metadata.httpStatusCode === 412)));

const r2 = () => {
  const names = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
  ] as const;
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`R2 Proof Library configuration is incomplete. Missing: ${missing.join(', ')}`);
  }
  return {
    bucket: process.env.R2_BUCKET_NAME!,
    client: new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    }),
  };
};

const readLocal = async () => {
  try {
    return parseIndex(await readFile(LOCAL_INDEX_PATH, 'utf8'));
  } catch (error) {
    if (isLocalMissing(error)) return emptyIndex();
    throw error;
  }
};
const writeLocal = async (index: ProofLibraryIndex) => {
  await mkdir(resolve(LOCAL_INDEX_PATH, '..'), { recursive: true });
  await writeFile(LOCAL_INDEX_PATH, JSON.stringify(serializedIndex(index), null, 2), 'utf8');
};

type R2Snapshot = { index: ProofLibraryIndex; exists: boolean; etag?: string };
const readR2 = async (): Promise<R2Snapshot> => {
  const { bucket, client } = r2();
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: INDEX_KEY }));
    if (!response.Body || !response.ETag) throw new Error('R2 returned an invalid Proof Library index.');
    return { index: parseIndex(await response.Body.transformToString()), exists: true, etag: response.ETag };
  } catch (error) {
    if (isMissing(error)) return { index: emptyIndex(), exists: false };
    throw error;
  }
};
const writeR2 = async (index: ProofLibraryIndex, snapshot: R2Snapshot) => {
  const { bucket, client } = r2();
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: INDEX_KEY,
    Body: JSON.stringify(serializedIndex(index)),
    ContentType: 'application/json',
    ...(snapshot.exists ? { IfMatch: snapshot.etag } : { IfNoneMatch: '*' }),
  }));
};

let localQueue: Promise<void> = Promise.resolve();
const readLocalQueued = () => {
  const operation = localQueue.then(readLocal);
  localQueue = operation.then(() => undefined, () => undefined);
  return operation;
};
const mutateLocal = <T>(mutate: IndexMutation<T>) => {
  const operation = localQueue.then(async () => {
    const outcome = mutate(await readLocal());
    if (outcome.changed) await writeLocal(outcome.index);
    return outcome.result;
  });
  localQueue = operation.then(() => undefined, () => undefined);
  return operation;
};
const mutateR2 = async <T>(mutate: IndexMutation<T>) => {
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
    const snapshot = await readR2();
    const outcome = mutate(snapshot.index);
    if (!outcome.changed) return outcome.result;
    try {
      await writeR2(outcome.index, snapshot);
      return outcome.result;
    } catch (error) {
      if (!isWriteConflict(error) || attempt === SAVE_ATTEMPTS) throw error;
    }
  }
  throw new Error('Proof Library save attempts were exhausted.');
};
const mutateIndex = <T>(mutate: IndexMutation<T>) =>
  process.env.NODE_ENV === 'production' ? mutateR2(mutate) : mutateLocal(mutate);

export const listProofRecords = async () => {
  const index =
    process.env.NODE_ENV === 'production'
      ? (await readR2()).index
      : await readLocalQueued();
  return [...index.items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
};

const linkHealth = (candidate: VideoPassageCandidate, items: ProofRecord[]): VideoPassageCandidateLinkHealth => {
  if (!candidate.link) return 'UNLINKED';
  const proof = items.find((item) => item.id === candidate.link!.proofId);
  if (!proof) return 'MISSING';
  if (proof.type !== candidate.link.proofType) return 'CHANGED';
  if (proof.status !== 'ACTIVE') return 'INACTIVE';
  if (proof.advertisingUseApproved !== true) return 'UNAPPROVED';
  return proof.updatedAt === candidate.link.proofUpdatedAt ? 'CURRENT' : 'CHANGED';
};

export const getProofLibrarySnapshot = async (): Promise<{ items: ProofRecord[]; candidates: VideoPassageCandidateView[] }> => {
  const index = process.env.NODE_ENV === 'production' ? (await readR2()).index : await readLocalQueued();
  const items = [...index.items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { items, candidates: [...index.candidates].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((candidate) => ({ ...candidate, linkHealth: linkHealth(candidate, items) })) };
};

export const addProofRecords = async (records: ProofRecord[]) => {
  if (!records.length) throw new Error('Add at least one proof record.');
  const normalized = records.map(normalizeRecord);
  if (normalized.some((record) => !record)) throw new Error('One or more proof records are invalid.');
  const valid = normalized as ProofRecord[];
  if (new Set(valid.map(({ id }) => id)).size !== valid.length) {
    throw new Error('Proof IDs must be unique within a batch.');
  }
  return mutateIndex((index) => {
    const existing = new Set(index.items.map(({ id }) => id));
    if (valid.some(({ id }) => existing.has(id))) throw new Error('A proof record with this ID already exists.');
    return { index: { ...index, items: [...valid, ...index.items] }, result: valid, changed: true };
  });
};

export const updateProofRecord = async (
  record: ProofRecord,
  expectedUpdatedAt: string
) => {
  const normalized = normalizeRecord(record);
  if (!normalized) throw new Error('Proof record is invalid.');
  return mutateIndex((index) => {
    const position = index.items.findIndex(({ id }) => id === normalized.id);
    if (position < 0) return { index, result: null, changed: false };
    const current = index.items[position];
    if (
      current.type !== normalized.type ||
      current.updatedAt !== expectedUpdatedAt ||
      current.createdAt !== normalized.createdAt ||
      Date.parse(normalized.updatedAt) <= Date.parse(current.updatedAt)
    ) {
      throw new Error('Proof record changed before this update could be saved.');
    }
    const items = [...index.items];
    items[position] = normalized;
    return { index: { ...index, items }, result: normalized, changed: true };
  });
};

const nextTimestamp = (current: string) => new Date(Math.max(Date.now(), Date.parse(current) + 1)).toISOString();
export class VideoPassageCandidateError extends Error { constructor(message: string, readonly status: 400 | 404) { super(message); } }
export const upsertVideoPassageCandidate = async (candidate: VideoPassageCandidate) => {
  const normalized = normalizeCandidate(candidate);
  if (!normalized) throw new Error('Video passage candidate is invalid.');
  return mutateIndex((index) => {
    const existing = index.candidates.find((item) => item.id === normalized.id);
    if (existing) return { index, result: { candidate: existing, created: false }, changed: false };
    return { index: { ...index, version: 2, candidates: [normalized, ...index.candidates] }, result: { candidate: normalized, created: true }, changed: true };
  });
};
export const mutateVideoPassageCandidate = async (id: string, action: 'link' | 'dismiss' | 'reopen', proofId?: string) => mutateIndex((index) => {
  const position = index.candidates.findIndex((candidate) => candidate.id === id);
  if (position < 0) throw new VideoPassageCandidateError('Video passage candidate was not found.', 404);
  const current = index.candidates[position];
  let next: VideoPassageCandidate;
  if (action === 'link') {
    const proof = index.items.find((item) => item.id === proofId);
    if (!proof || proof.status !== 'ACTIVE' || proof.advertisingUseApproved !== true) throw new VideoPassageCandidateError('Proof is not currently eligible for linking.', 400);
    if (current.status === 'DISMISSED') throw new VideoPassageCandidateError('Reopen the video passage candidate before linking it.', 400);
    next = { ...current, status: 'LINKED', link: { proofId: proof.id, proofType: proof.type, proofUpdatedAt: proof.updatedAt }, updatedAt: nextTimestamp(current.updatedAt) };
  } else next = { ...current, status: action === 'dismiss' ? 'DISMISSED' : 'PENDING', updatedAt: nextTimestamp(current.updatedAt) };
  if (action !== 'link') delete next.link;
  const candidates = [...index.candidates]; candidates[position] = next;
  return { index: { ...index, version: 2, candidates }, result: next, changed: true };
});
