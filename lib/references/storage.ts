import { mkdir, readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { MediaAsset } from '@/lib/media/types';
import type { ReferenceLibraryItem } from '@/lib/references/types';

const INDEX_KEY = '_metadata/reference-library.json';
const LOCAL_INDEX_PATH = resolve(
  process.cwd(),
  process.env.REFERENCE_LIBRARY_INDEX || 'data/reference-library.json'
);

interface ReferenceLibraryIndex {
  version: 1;
  items: ReferenceLibraryItem[];
}

const emptyIndex = (): ReferenceLibraryIndex => ({ version: 1, items: [] });

const isMissingObjectError = (error: unknown) =>
  error instanceof NoSuchKey ||
  (typeof error === 'object' &&
    error !== null &&
    (('name' in error && error.name === 'NoSuchKey') ||
      ('Code' in error && error.Code === 'NoSuchKey') ||
      ('code' in error && error.code === 'NoSuchKey')));

const parseIndex = (raw: string): ReferenceLibraryIndex => {
  try {
    const parsed = JSON.parse(raw) as Partial<ReferenceLibraryIndex>;
    return {
      version: 1,
      items: Array.isArray(parsed.items) ? parsed.items : [],
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
  media: MediaAsset[]
): Promise<ReferenceLibraryItem[]> => {
  const index = await readIndex();
  const existingIds = new Set(index.items.map((item) => item.id));
  const addedAt = new Date().toISOString();
  const additions = media
    .filter((item) => !existingIds.has(item.id))
    .map((item) => ({ ...item, addedAt }));

  const nextIndex: ReferenceLibraryIndex = {
    version: 1,
    items: [...additions, ...index.items],
  };

  await writeIndex(nextIndex);
  return nextIndex.items;
};
