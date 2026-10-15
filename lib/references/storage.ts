import { parseReferenceCuratedMetadata, type ReferenceCuratedMetadata } from '@/lib/references/types';
import { mkdir, readFile, writeFile, rename, unlink } from 'fs/promises';
import { randomUUID } from 'node:crypto';
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
  ReferenceLibraryType,
} from '@/lib/references/types';

const INDEX_KEY = '_metadata/reference-library.json';
const configuredIndexPath = process.env.REFERENCE_LIBRARY_INDEX;
const LOCAL_INDEX_PATH = configuredIndexPath
  ? resolve(/* turbopackIgnore: true */ process.cwd(), configuredIndexPath)
  : resolve(process.cwd(), 'data', 'reference-library.json');

interface ReferenceLibraryIndex {
  version: 3;
  items: ReferenceLibraryItem[];
}

export interface ReferenceLibraryAddition {
  media: MediaAsset;
  referenceType: ReferenceLibraryType;
  angle: CreativeCategoryId;
  angleSource: ReferenceAngleSource;
}

export interface ReferenceLibraryRemoval {
  items: ReferenceLibraryItem[];
  removed: ReferenceLibraryItem[];
}

const emptyIndex = (): ReferenceLibraryIndex => ({ version: 3, items: [] });
const ANGLE_SOURCES: ReferenceAngleSource[] = [
  'ai',
  'manual',
  'legacy',
  'fallback',
];
const REFERENCE_TYPES: ReferenceLibraryType[] = ['layout', 'tra'];

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
  const referenceType =
    typeof item.referenceType === 'string' &&
    REFERENCE_TYPES.includes(item.referenceType as ReferenceLibraryType)
      ? (item.referenceType as ReferenceLibraryType)
      : 'layout';
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
    referenceType,
    angle,
    angleSource,
    ...(parseReferenceCuratedMetadata(item) ?? {}),
  };
};

const parseIndex = (raw: string): ReferenceLibraryIndex => {
  try {
    const parsed = JSON.parse(raw) as { items?: unknown };
    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    return {
      version: 3,
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

// Mutations fail closed rather than silently rewriting an unreadable or future index.
type StoredIndex = { index: ReferenceLibraryIndex; raw: Record<string, unknown>; rawItems: Record<string, unknown>[]; etag: string | null };
function strictIndex(bytes: string, etag: string | null): StoredIndex {
  const raw = JSON.parse(bytes) as Record<string, unknown>;
  if (!raw || Array.isArray(raw) || ![1, 2, 3].includes(raw.version as number) || !Array.isArray(raw.items)) throw new Error('Reference index is unsupported; existing data was preserved.');
  const items = raw.items.map(normalizeItem);
  if (items.some(item => !item) || new Set(items.map(item => item!.id)).size !== items.length
    || raw.items.some(item => !parseReferenceCuratedMetadata(item))) throw new Error('Reference index is invalid; existing data was preserved.');
  return { index: { version: 3, items: items as ReferenceLibraryItem[] }, raw, rawItems: raw.items as Record<string, unknown>[], etag };
}
const missingIndex = (): StoredIndex => ({ index: emptyIndex(), raw: {}, rawItems: [], etag: null });
function serialize(next: ReferenceLibraryIndex, stored: StoredIndex): string {
  const rawById = new Map(stored.rawItems.map(item => [item.id, item]));
  const items = next.items.map(item => {
    const raw = { ...rawById.get(item.id) };
    // Explicit editorial clearing must not resurrect prior raw notes/tags.
    delete raw.notes; delete raw.tags;
    return { ...raw, ...item };
  });
  return JSON.stringify({ ...stored.raw, version: 3, items });
}
const conflict = (error: unknown) => {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return ['PreconditionFailed', 'ConditionalRequestConflict'].includes(value?.name ?? '') || [409, 412].includes(value?.$metadata?.httpStatusCode ?? 0);
};
async function readR2(stable: ReturnType<typeof createR2Client>, strict: boolean): Promise<StoredIndex> {
  try {
    const response = await stable.client.send(new GetObjectCommand({ Bucket: stable.bucketName, Key: INDEX_KEY }));
    if (!response.Body) throw new Error('Reference index body is missing.');
    const bytes = await response.Body.transformToString();
    if (!strict) return { ...missingIndex(), index: parseIndex(bytes) };
    if (!response.ETag) throw new Error('Reference index revision is missing; existing data was preserved.');
    return strictIndex(bytes, response.ETag);
  } catch (error) { if (isMissingObjectError(error)) return missingIndex(); throw error; }
}
const readIndex = async (): Promise<ReferenceLibraryIndex> => process.env.NODE_ENV === 'production'
  ? (await readR2(createR2Client(), false)).index : readLocalIndex();

// Serialize local writers for this process. Production uses R2 conditional writes across instances.
const localQueues = new Map<string, Promise<unknown>>();
async function mutateIndex<T>(change: (index: ReferenceLibraryIndex) => { index: ReferenceLibraryIndex; result: T }): Promise<T> {
  if (process.env.NODE_ENV === 'production') {
    const stable = createR2Client();
    for (let attempt = 0; attempt < 4; attempt++) {
      const stored = await readR2(stable, true), next = change(stored.index);
      if (JSON.stringify(next.index) === JSON.stringify(stored.index)) return next.result;
      try {
        await stable.client.send(new PutObjectCommand({ Bucket: stable.bucketName, Key: INDEX_KEY,
          Body: serialize(next.index, stored), ContentType: 'application/json',
          ...(stored.etag ? { IfMatch: stored.etag } : { IfNoneMatch: '*' }) }));
        return next.result;
      } catch (error) { if (!conflict(error)) throw error; }
    }
    throw new Error('Reference library changed concurrently. Reload and retry; existing data was preserved.');
  }
  const previous = localQueues.get(LOCAL_INDEX_PATH) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    let stored: StoredIndex;
    try { stored = strictIndex(await readFile(LOCAL_INDEX_PATH, 'utf8'), null); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; stored = missingIndex(); }
    const next = change(stored.index);
    if (JSON.stringify(next.index) === JSON.stringify(stored.index)) return next.result;
    await mkdir(resolve(LOCAL_INDEX_PATH, '..'), { recursive: true });
    const temporary = LOCAL_INDEX_PATH + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, serialize(next.index, stored), { encoding: 'utf8', flag: 'wx' }); await rename(temporary, LOCAL_INDEX_PATH); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return next.result;
  });
  localQueues.set(LOCAL_INDEX_PATH, operation);
  try { return await operation; } finally { if (localQueues.get(LOCAL_INDEX_PATH) === operation) localQueues.delete(LOCAL_INDEX_PATH); }
}

const newestFirst = (a: ReferenceLibraryItem, b: ReferenceLibraryItem) =>
  new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime();

export const listAllReferenceLibrary = async (): Promise<ReferenceLibraryItem[]> => {
  const index = await readIndex();
  return [...index.items].sort(newestFirst);
};

export const listReferenceLibrary = async (): Promise<ReferenceLibraryItem[]> => {
  const items = await listAllReferenceLibrary();
  return items.filter((item) => item.referenceType === 'layout');
};

export const addToReferenceLibrary = async (additions: ReferenceLibraryAddition[]): Promise<ReferenceLibraryItem[]> => {
  const addedAt = new Date().toISOString();
  return mutateIndex(index => {
    const existingIds = new Set(index.items.map(item => item.id));
    const additionsUnique = additions.filter(({ media }) => {
      if (existingIds.has(media.id)) return false;
      existingIds.add(media.id); return true;
    });
    const items = [...additionsUnique.map(({ media, referenceType, angle, angleSource }) => ({ ...media, addedAt, referenceType, angle, angleSource })), ...index.items];
    return { index: { version: 3, items }, result: items };
  });
};

export const updateReferenceAngle = async (id: string, angle: CreativeCategoryId): Promise<ReferenceLibraryItem[]> => mutateIndex(index => {
  if (!index.items.some(item => item.id === id)) throw new Error('Reference image was not found.');
  const items = index.items.map(item => {
    if (item.id !== id) return item;
    if (item.referenceType !== 'layout') throw new Error('TRA reference images do not use creative-angle folders.');
    return { ...item, angle, angleSource: 'manual' as const };
  });
  return { index: { version: 3, items }, result: items };
});

export const removeFromReferenceLibrary = async (ids: string[]): Promise<ReferenceLibraryRemoval> => mutateIndex(index => {
  const selected = new Set(ids), removed = index.items.filter(item => selected.has(item.id));
  const items = index.items.filter(item => !selected.has(item.id));
  return { index: { version: 3, items }, result: { items, removed } };
});

export async function updateReferenceMetadata(id: string, patch: ReferenceCuratedMetadata): Promise<ReferenceLibraryItem[]> {
  if (!parseReferenceCuratedMetadata(patch)) throw new Error('Invalid reference notes or tags.');
  return mutateIndex(index => {
    if (!index.items.some(item => item.id === id)) throw new Error('Reference image was not found.');
    const items = index.items.map(item => {
      if (item.id !== id) return item;
      const { notes: _notes, tags: _tags, ...unchanged } = item;
      return { ...unchanged, ...parseReferenceCuratedMetadata({ ...item, ...patch })! };
    });
    return { index: { version: 3, items }, result: items };
  });
}
