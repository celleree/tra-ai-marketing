import { mkdir, readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ProofRecord } from '@/lib/proof/types';
import {
  isProofId,
  parseCaseStudyProofDraft,
  parseReviewProofDraft,
} from '@/lib/proof/validation';

const INDEX_KEY = '_metadata/proof-library.json';
const LOCAL_INDEX_PATH = resolve(process.cwd(), 'data', 'proof-library.json');
const SAVE_ATTEMPTS = 3;
const BASE_KEYS = ['id', 'type', 'tags', 'status', 'createdAt', 'updatedAt'];
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

type ProofLibraryIndex = { version: 1; items: ProofRecord[] };
type IndexMutation<T> = (index: ProofLibraryIndex) => {
  index: ProofLibraryIndex;
  result: T;
  changed: boolean;
};

const emptyIndex = (): ProofLibraryIndex => ({ version: 1, items: [] });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const normalizeRecord = (value: unknown): ProofRecord | null => {
  if (!isRecord(value) || !isProofId(value.id)) return null;
  if (!Array.isArray(value.tags) || !isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)) {
    return null;
  }
  if (
    (value.status !== 'ACTIVE' && value.status !== 'INACTIVE') ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt)
  ) {
    return null;
  }
  const base = {
    id: value.id,
    tags: value.tags,
    status: value.status,
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

const parseIndex = (raw: string): ProofLibraryIndex => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('Proof Library index contains malformed JSON.', { cause: error });
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== 1 ||
    !Array.isArray(value.items)
  ) {
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
  return { version: 1, items: validItems };
};

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
  await writeFile(LOCAL_INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
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
    Body: JSON.stringify(index),
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
    return { index: { version: 1, items: [...valid, ...index.items] }, result: valid, changed: true };
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
    return { index: { version: 1, items }, result: normalized, changed: true };
  });
};
