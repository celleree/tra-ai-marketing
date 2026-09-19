import { parseGeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { isCreativeCategory } from '@/lib/creative-categories';
import { isCreativeFormat } from '@/lib/creative-formats';
import type { CreativeRecord } from '@/lib/creatives/generated';
import { parseCreativeCopyContract } from '@/lib/creatives/copy-contract';
import {
  parseCreativeHumanReview,
  parseCreativeLifecycle,
  type CreativeHumanReview,
  type CreativeLifecycle,
} from '@/lib/creatives/human-review';
import { parseCreativePlanning } from '@/lib/creatives/planning-metadata';
import { parseCreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import { parseCreativeProofProvenance } from '@/lib/proof/provenance';
import {
  parseCreativeIdentity,
  validateCreativeIdentityTransition,
} from '@/lib/creatives/identity';
import { isCreativePlacement } from '@/lib/creatives/placements';
import {
  getPrivateMediaUrl,
  getStoredImageMimeType,
  isAllowedImageMimeType,
  isSafeMediaId,
} from '@/lib/media/storage';

const INDEX_KEY = '_metadata/tra-creatives.json';
const LOCAL_INDEX_PATH = resolve(process.cwd(), 'data/tra-creatives.json');
const SAFE_CREATIVE_ID = /^creative_[a-f0-9]{32}$/;
const R2_SAVE_ATTEMPTS = 3;

interface CreativeLibraryIndex {
  version: 1;
  items: CreativeRecord[];
}

const emptyIndex = (): CreativeLibraryIndex => ({ version: 1, items: [] });

const isMissingObjectError = (error: unknown) =>
  error instanceof NoSuchKey ||
  (typeof error === 'object' &&
    error !== null &&
    (('name' in error && error.name === 'NoSuchKey') ||
      ('Code' in error && error.Code === 'NoSuchKey') ||
      ('code' in error && error.code === 'NoSuchKey')));

const isPreconditionError = (error: unknown) => {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const statusCode = candidate.$metadata?.httpStatusCode;
  return (
    candidate.name === 'PreconditionFailed' ||
    candidate.name === 'ConditionalRequestConflict' ||
    candidate.Code === 'PreconditionFailed' ||
    candidate.Code === 'ConditionalRequestConflict' ||
    candidate.code === 'PreconditionFailed' ||
    candidate.code === 'ConditionalRequestConflict' ||
    statusCode === 409 ||
    statusCode === 412
  );
};

const isLocalMissingError = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ENOENT';

export const isSafeCreativeId = (creativeId: string) =>
  SAFE_CREATIVE_ID.test(creativeId);

const normalizeRecord = (value: unknown): CreativeRecord | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const image =
    record.image && typeof record.image === 'object'
      ? (record.image as Record<string, unknown>)
      : null;
  const copyContract = parseCreativeCopyContract(record);

  const id = typeof record.id === 'string' ? record.id : '';
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : '';
  const category = typeof record.category === 'string' ? record.category : '';
  const imageId = typeof image?.id === 'string' ? image.id : '';
  const fileName = typeof image?.fileName === 'string' ? image.fileName : '';
  const originalName =
    typeof image?.originalName === 'string' ? image.originalName : '';
  const mimeType = typeof image?.mimeType === 'string' ? image.mimeType : '';
  const size = typeof image?.size === 'number' ? image.size : Number(image?.size);
  const url = typeof image?.url === 'string' ? image.url : '';
  const source = record.source === undefined ? 'generated' : record.source;
  const videoFrameSelection = parseGeneratedVideoFrameSelection(record.videoFrameSelection);
  const planning = parseCreativePlanning(record.planning);
  const generationProvenance = parseCreativeGenerationProvenance(record.generationProvenance);
  const proofProvenance = parseCreativeProofProvenance(record.proofProvenance);
  const identity = parseCreativeIdentity(record.identity, id);
  const humanReview = parseCreativeHumanReview(record.humanReview);
  const lifecycle = parseCreativeLifecycle(record.lifecycle);
  const format =
    typeof record.format === 'string' && isCreativeFormat(record.format)
      ? record.format
      : undefined;
  const placement = isCreativePlacement(record.placement)
    ? record.placement
    : undefined;
  const referenceImageId =
    typeof record.referenceImageId === 'string'
      ? record.referenceImageId
      : undefined;

  if (
    !isSafeCreativeId(id) ||
    !createdAt ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !isCreativeCategory(category) ||
    !isSafeMediaId(imageId) ||
    !getStoredImageMimeType(fileName) ||
    !fileName.startsWith(`${imageId}.`) ||
    !isAllowedImageMimeType(mimeType) ||
    !Number.isFinite(size) ||
    size <= 0 ||
    !url ||
    !copyContract ||
    !copyContract.copy.primaryText ||
    !copyContract.copy.headline ||
    (source !== 'generated' && source !== 'uploaded') ||
    (record.format !== undefined && !format) ||
    (record.placement !== undefined && !placement) ||
    (referenceImageId !== undefined && !isSafeMediaId(referenceImageId))
    || (record.videoFrameSelection !== undefined && !videoFrameSelection)
    || (record.planning !== undefined && !planning)
    || (record.generationProvenance !== undefined && !generationProvenance)
    || (record.proofProvenance !== undefined && !proofProvenance)
    || (record.identity !== undefined && !identity)
    || (record.humanReview !== undefined && !humanReview)
    || (record.lifecycle !== undefined && !lifecycle)
  ) {
    return null;
  }

  return {
    id,
    createdAt,
    image: {
      id: imageId,
      fileName,
      originalName,
      mimeType,
      size,
      url: getPrivateMediaUrl(fileName),
    },
    category,
    ...copyContract,
    source,
    ...(format ? { format } : {}),
    ...(placement ? { placement } : {}),
    ...(referenceImageId ? { referenceImageId } : {}),
    ...(videoFrameSelection ? { videoFrameSelection } : {}),
    ...(planning ? { planning } : {}),
    ...(generationProvenance ? { generationProvenance } : {}),
    ...(proofProvenance ? { proofProvenance } : {}),
    ...(identity ? { identity } : {}),
    ...(humanReview ? { humanReview } : {}),
    ...(lifecycle ? { lifecycle } : {}),
  };
};

const parseIndex = (raw: string): CreativeLibraryIndex => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('Creative library index contains malformed JSON.', {
      cause: error,
    });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Creative library index has an invalid schema.');
  }

  const candidate = parsed as { version?: unknown; items?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.items)) {
    throw new Error('Creative library index has an invalid schema.');
  }

  const items = candidate.items.map(normalizeRecord);
  if (items.some((item) => !item)) {
    throw new Error('Creative library index contains an invalid record.');
  }

  const validItems = items as CreativeRecord[];
  if (new Set(validItems.map((item) => item.id)).size !== validItems.length) {
    throw new Error('Creative library index contains duplicate Creative IDs.');
  }

  return { version: 1, items: validItems };
};

const getR2Config = () => {
  const required = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
  ] as const;
  const missing = required.filter((name) => !process.env[name]);

  if (missing.length) {
    throw new Error(
      `R2 creative library configuration is incomplete. Missing: ${missing.join(', ')}`
    );
  }

  return {
    accountId: process.env.R2_ACCOUNT_ID!,
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    bucketName: process.env.R2_BUCKET_NAME!,
  };
};

const createR2Client = () => {
  const config = getR2Config();
  return {
    bucketName: config.bucketName,
    client: new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    }),
  };
};

const readLocalIndex = async (): Promise<CreativeLibraryIndex> => {
  try {
    return parseIndex(await readFile(LOCAL_INDEX_PATH, 'utf-8'));
  } catch (error) {
    if (isLocalMissingError(error)) return emptyIndex();
    throw error;
  }
};

const writeLocalIndex = async (index: CreativeLibraryIndex) => {
  await mkdir(resolve(LOCAL_INDEX_PATH, '..'), { recursive: true });
  await writeFile(LOCAL_INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');
};

interface R2IndexSnapshot {
  index: CreativeLibraryIndex;
  etag?: string;
  exists: boolean;
}

const readR2Index = async (): Promise<R2IndexSnapshot> => {
  const { client, bucketName } = createR2Client();

  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: INDEX_KEY })
    );
    if (!response.Body) {
      throw new Error('R2 returned an empty creative library index.');
    }
    if (!response.ETag) {
      throw new Error('R2 returned a creative library index without an ETag.');
    }
    return {
      index: parseIndex(await response.Body.transformToString()),
      etag: response.ETag,
      exists: true,
    };
  } catch (error) {
    if (isMissingObjectError(error)) {
      return { index: emptyIndex(), exists: false };
    }
    throw error;
  }
};

const writeR2Index = async (
  index: CreativeLibraryIndex,
  snapshot: R2IndexSnapshot
) => {
  const { client, bucketName } = createR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: INDEX_KEY,
      Body: JSON.stringify(index),
      ContentType: 'application/json',
      ...(snapshot.exists
        ? { IfMatch: snapshot.etag }
        : { IfNoneMatch: '*' }),
    })
  );
};

const mergeBatch = (
  index: CreativeLibraryIndex,
  records: CreativeRecord[]
): CreativeLibraryIndex => {
  const existingIds = new Set(index.items.map((record) => record.id));
  if (records.some((record) => existingIds.has(record.id))) {
    throw new Error('A creative with this ID already exists.');
  }
  const persistedRecords = new Map(index.items.map((record) => [record.id, record]));
  for (const record of records) {
    if (!record.identity) continue;
    const parentId = record.identity.parentCreativeId;
    const parent = parentId ? persistedRecords.get(parentId) ?? null : null;
    if (!validateCreativeIdentityTransition(record.identity, record.id, parent)) {
      throw new Error('Creative identity transition is invalid.');
    }
  }
  return { version: 1, items: [...records, ...index.items] };
};

let localSaveQueue: Promise<void> = Promise.resolve();

const mutateLocalIndex = <Result>(
  mutate: (index: CreativeLibraryIndex) => {
    index: CreativeLibraryIndex;
    result: Result;
    changed: boolean;
  }
) => {
  const operation = localSaveQueue.then(async () => {
    const outcome = mutate(await readLocalIndex());
    if (outcome.changed) await writeLocalIndex(outcome.index);
    return outcome.result;
  });
  localSaveQueue = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
};

const mutateR2Index = async <Result>(
  mutate: (index: CreativeLibraryIndex) => {
    index: CreativeLibraryIndex;
    result: Result;
    changed: boolean;
  }
) => {
  for (let attempt = 1; attempt <= R2_SAVE_ATTEMPTS; attempt += 1) {
    const snapshot = await readR2Index();
    const outcome = mutate(snapshot.index);
    if (!outcome.changed) return outcome.result;
    try {
      await writeR2Index(outcome.index, snapshot);
      return outcome.result;
    } catch (error) {
      if (!isPreconditionError(error) || attempt === R2_SAVE_ATTEMPTS) {
        throw error;
      }
    }
  }

  throw new Error('Creative library save attempts were exhausted.');
};

const saveLocalCreativeBatch = (records: CreativeRecord[]) =>
  mutateLocalIndex((index) => ({
    index: mergeBatch(index, records),
    result: records,
    changed: true,
  }));

const saveR2CreativeBatch = (records: CreativeRecord[]) =>
  mutateR2Index((index) => ({
    index: mergeBatch(index, records),
    result: records,
    changed: true,
  }));

type CreativeReviewStateUpdate =
  | { humanReview: CreativeHumanReview }
  | { lifecycle: CreativeLifecycle };

const validateReviewStateUpdate = (update: CreativeReviewStateUpdate) => {
  const keys = Object.keys(update);
  if (keys.length !== 1 || (keys[0] !== 'humanReview' && keys[0] !== 'lifecycle')) {
    throw new Error('Creative review state update must contain exactly one property.');
  }

  if ('humanReview' in update) {
    const humanReview = parseCreativeHumanReview(update.humanReview);
    if (!humanReview) throw new Error('Creative human review is invalid.');
    return { humanReview } as const;
  }

  const lifecycle = parseCreativeLifecycle(update.lifecycle);
  if (!lifecycle) throw new Error('Creative lifecycle is invalid.');
  return { lifecycle } as const;
};

const updateReviewState = (
  index: CreativeLibraryIndex,
  creativeId: string,
  update: ReturnType<typeof validateReviewStateUpdate>
) => {
  const itemIndex = index.items.findIndex((item) => item.id === creativeId);
  if (itemIndex === -1) {
    return { index, result: null, changed: false };
  }

  const updated = { ...index.items[itemIndex], ...update };
  const items = [...index.items];
  items[itemIndex] = updated;
  return { index: { version: 1 as const, items }, result: updated, changed: true };
};

export const listCreatives = async (): Promise<CreativeRecord[]> => {
  const index =
    process.env.NODE_ENV === 'production'
      ? (await readR2Index()).index
      : await readLocalIndex();
  return [...index.items].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
};

export const saveCreativeBatch = async (
  records: CreativeRecord[]
): Promise<CreativeRecord[]> => {
  const normalized = records.map(normalizeRecord);
  if (normalized.some((record) => !record)) {
    throw new Error('One or more creative records are invalid.');
  }

  const validRecords = normalized as CreativeRecord[];
  const batchIds = new Set(validRecords.map((record) => record.id));
  if (batchIds.size !== validRecords.length) {
    throw new Error('Creative IDs must be unique within a batch.');
  }

  const persistedRecords = validRecords.map((record) => ({
    ...record,
    humanReview: { status: 'PENDING' } as const,
    lifecycle: {
      status: 'ACTIVE' as const,
      updatedAt: new Date(record.createdAt).toISOString(),
    },
  }));

  return process.env.NODE_ENV === 'production'
    ? saveR2CreativeBatch(persistedRecords)
    : saveLocalCreativeBatch(persistedRecords);
};

export const updateCreativeReviewState = async (
  creativeId: string,
  update: CreativeReviewStateUpdate
): Promise<CreativeRecord | null> => {
  if (!isSafeCreativeId(creativeId)) {
    throw new Error('Creative ID is invalid.');
  }

  const validUpdate = validateReviewStateUpdate(update);
  const mutate = (index: CreativeLibraryIndex) =>
    updateReviewState(index, creativeId, validUpdate);

  return process.env.NODE_ENV === 'production'
    ? mutateR2Index(mutate)
    : mutateLocalIndex(mutate);
};
