import { mkdir, readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  isCreativeCategory,
  type CreativeCategoryId,
} from '@/lib/creative-categories';
import type { MediaAsset } from '@/lib/media/types';
import type {
  ReferenceAngleSource,
  ReferenceLibraryItem,
} from '@/lib/references/types';

const INDEX_KEY = '_metadata/reference-library.json';
const configuredIndexPath = process.env.REFERENCE_LIBRARY_INDEX;
const LOCAL_INDEX_PATH = configuredIndexPath
  ? resolve(/* turbopackIgnore: true */ process.cwd(), configuredIndexPath)
  : resolve(process.cwd(), 'data', 'reference-library.json');

interface ReferenceLibraryIndex {
  version: 2;
  items: ReferenceLibraryItem[];
}

export interface ReferenceLibraryAddition {
  media: MediaAsset;
  angle: CreativeCategoryId;
  angleSource: ReferenceAngleSource;
}

export interface ReferenceLibraryRemoval {
  items: ReferenceLibraryItem[];
  removed: ReferenceLibraryItem[];
}

const emptyIndex = (): ReferenceLibraryIndex => ({ version: 2, items: [] });
const ANGLE_SOURCES: ReferenceAngleSource[] = [
  'ai',
  'manual',
  'legacy',
  'fallback',
];

const isMissingObjectError = (error: unknown) =>
  error instanceof NoSuchKey ||
  (typeof error === 'object' &&
    error !== null &&
    (('name' in error && error.name === 'NoSuchKey') ||
      ('Code' in error && error.Code === 'NoSuchKey') ||
      ('code' in error && error.code === 'NoSuchKey')));

const normalizeItem = (value: unknown): ReferenceLibraryItem | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;

  const id = typeof item.id === 'string' ? item.id : '';
  const fileName = typeof item.fileName === 'string' ? item.fileName : '';
  const originalName =
    typeof item.originalName === 'string' ? item.originalName : 'reference';
  const mimeType = typeof item.mimeType === 'string' ? item.mimeType : '';
  const size = typeof item.size === 'number' ? item.size : Number(item.size);
  const url = typeof item.url === 'string' ? item.url : '';
  const addedAt =
    typeof item.addedAt === 'string' ? item.addedAt : new Date(0).toISOString();
  const angle =
    typeof item.angle === 'string' && isCreativeCategory(item.angle)
      ? item.angle
      : 'customer-problems';
  const angleSource =
    typeof item.angleSource === 'string' &&
    ANGLE_SOURCES.includes(item.angleSource as ReferenceAngleSource)
      ? (item.angleSource as ReferenceAngleSource)
      : 'legacy';

  if (!id || !fileName || !mimeType || !url || !Number.isFinite(size)) {
    return null;
  }

  return {
    id,
    fileName,
    originalName,
    mimeType: mimeType as MediaAsset['mimeType'],
    size,
    url,
    addedAt,
    angle,
    angleSource,
  };
};

const parseIndex = (raw: string): ReferenceLibraryIndex => {
  try {
    const parsed = JSON.parse(raw) as { items?: unknown };
    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    return {
      version: 2,
      items: rawItems
        .map(normalizeItem)
        .filter((item): item is ReferenceLibraryItem => Boolean(item)),
    };
  } catch {
    return emptyIndex();
  }
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
      `R2 reference library configuration is incomplete. Missing: ${missing.join(', ')}`
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

const readLocalIndex = async (): Promise<ReferenceLibraryIndex> => {
  try {
    return parseIndex(await readFile(LOCAL_INDEX_PATH, 'utf-8'));
  } catch {
    return emptyIndex();
  }
};

const writeLocalIndex = async (index: ReferenceLibraryIndex) => {
  await mkdir(resolve(LOCAL_INDEX_PATH, '..'), { recursive: true });
  await writeFile(LOCAL_INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');
};

const readR2Index = async (): Promise<ReferenceLibraryIndex> => {
  const { client, bucketName } = createR2Client();

  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: INDEX_KEY })
    );
    if (!response.Body) return emptyIndex();
    return parseIndex(await response.Body.transformToString());
  } catch (error) {
    if (isMissingObjectError(error)) return emptyIndex();
    throw error;
  }
};

const writeR2Index = async (index: ReferenceLibraryIndex) => {
  const { client, bucketName } = createR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: INDEX_KEY,
      Body: JSON.stringify(index),
      ContentType: 'application/json',
    })
  );
};

const readIndex = () =>
  process.env.NODE_ENV === 'production' ? readR2Index() : readLocalIndex();

const writeIndex = (index: ReferenceLibraryIndex) =>
  process.env.NODE_ENV === 'production'
    ? writeR2Index(index)
    : writeLocalIndex(index);

export const listReferenceLibrary = async (): Promise<ReferenceLibraryItem[]> => {
  const index = await readIndex();
  return [...index.items].sort(
    (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
  );
};

export const addToReferenceLibrary = async (
  additions: ReferenceLibraryAddition[]
): Promise<ReferenceLibraryItem[]> => {
  const index = await readIndex();
  const existingIds = new Set(index.items.map((item) => item.id));
  const addedAt = new Date().toISOString();
  const nextItems = additions
    .filter(({ media }) => !existingIds.has(media.id))
    .map(({ media, angle, angleSource }) => ({
      ...media,
      addedAt,
      angle,
      angleSource,
    }));

  const nextIndex: ReferenceLibraryIndex = {
    version: 2,
    items: [...nextItems, ...index.items],
  };

  await writeIndex(nextIndex);
  return nextIndex.items;
};

export const updateReferenceAngle = async (
  id: string,
  angle: CreativeCategoryId
): Promise<ReferenceLibraryItem[]> => {
  const index = await readIndex();
  let found = false;

  const items = index.items.map((item) => {
    if (item.id !== id) return item;
    found = true;
    return { ...item, angle, angleSource: 'manual' as const };
  });

  if (!found) {
    throw new Error('Reference image was not found.');
  }

  await writeIndex({ version: 2, items });
  return items;
};

export const removeFromReferenceLibrary = async (
  ids: string[]
): Promise<ReferenceLibraryRemoval> => {
  const index = await readIndex();
  const selected = new Set(ids);
  const removed = index.items.filter((item) => selected.has(item.id));
  const items = index.items.filter((item) => !selected.has(item.id));

  if (!removed.length) {
    return { items: index.items, removed: [] };
  }

  await writeIndex({ version: 2, items });
  return { items, removed };
};
