import { mkdir, readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const ATTRIBUTION_PREFIX = '_metadata/creative-attribution';
const configuredAttributionDir = process.env.CREATIVE_ATTRIBUTION_DIR;
const LOCAL_ATTRIBUTION_DIR = configuredAttributionDir
  ? resolve(
      /* turbopackIgnore: true */ process.cwd(),
      configuredAttributionDir
    )
  : resolve(process.cwd(), 'data', 'creative-attribution');
const SAFE_CREATIVE_ID = /^(creative|upload)_[a-f0-9]{32}$/;

export interface CreativeMetaAttribution {
  adAccountId: string;
  campaignId: string;
  adSetId: string;
  metaAdId: string;
  metaCreativeId: string;
  metaImageHash: string;
  publishedAt: string;
}

export interface CreativeAttributionRecord {
  version: 1;
  creativeId: string;
  mediaId: string;
  fileName: string;
  creativeUrl: string;
  source: 'generated' | 'uploaded';
  category: string;
  format: string;
  createdAt: string;
  updatedAt: string;
  meta?: CreativeMetaAttribution;
}

export interface RecordCreativeMetaAttributionInput {
  creativeId: string;
  mediaId: string;
  fileName: string;
  creativeUrl: string;
  source: 'generated' | 'uploaded';
  category: string;
  format: string;
  adAccountId: string;
  campaignId: string;
  adSetId: string;
  metaAdId: string;
  metaCreativeId: string;
  metaImageHash: string;
}

const isMissingObjectError = (error: unknown) =>
  error instanceof NoSuchKey ||
  (typeof error === 'object' &&
    error !== null &&
    (('name' in error && error.name === 'NoSuchKey') ||
      ('Code' in error && error.Code === 'NoSuchKey') ||
      ('code' in error && error.code === 'NoSuchKey')));

const assertCreativeId = (creativeId: string) => {
  if (!SAFE_CREATIVE_ID.test(creativeId)) {
    throw new Error('Creative attribution ID is invalid.');
  }
};

const parseRecord = (raw: string): CreativeAttributionRecord | null => {
  try {
    const parsed = JSON.parse(raw) as CreativeAttributionRecord;
    if (
      parsed.version !== 1 ||
      !SAFE_CREATIVE_ID.test(parsed.creativeId) ||
      !parsed.mediaId ||
      !parsed.fileName ||
      !parsed.creativeUrl
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
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
      `R2 creative attribution configuration is incomplete. Missing: ${missing.join(', ')}`
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

const recordKey = (creativeId: string) =>
  `${ATTRIBUTION_PREFIX}/${creativeId}.json`;

const readLocalRecord = async (
  creativeId: string
): Promise<CreativeAttributionRecord | null> => {
  try {
    return parseRecord(
      await readFile(resolve(LOCAL_ATTRIBUTION_DIR, `${creativeId}.json`), 'utf-8')
    );
  } catch {
    return null;
  }
};

const writeLocalRecord = async (record: CreativeAttributionRecord) => {
  await mkdir(LOCAL_ATTRIBUTION_DIR, { recursive: true });
  await writeFile(
    resolve(LOCAL_ATTRIBUTION_DIR, `${record.creativeId}.json`),
    JSON.stringify(record, null, 2),
    'utf-8'
  );
};

const readR2Record = async (
  creativeId: string
): Promise<CreativeAttributionRecord | null> => {
  const { client, bucketName } = createR2Client();
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: recordKey(creativeId) })
    );
    if (!response.Body) return null;
    return parseRecord(await response.Body.transformToString());
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
};

const writeR2Record = async (record: CreativeAttributionRecord) => {
  const { client, bucketName } = createR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: recordKey(record.creativeId),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    })
  );
};

const readRecord = (creativeId: string) =>
  process.env.NODE_ENV === 'production'
    ? readR2Record(creativeId)
    : readLocalRecord(creativeId);

const writeRecord = (record: CreativeAttributionRecord) =>
  process.env.NODE_ENV === 'production'
    ? writeR2Record(record)
    : writeLocalRecord(record);

export const getCreativeAttribution = async (
  creativeId: string
): Promise<CreativeAttributionRecord | null> => {
  assertCreativeId(creativeId);
  return readRecord(creativeId);
};

export const recordCreativeMetaAttribution = async (
  input: RecordCreativeMetaAttributionInput
): Promise<CreativeAttributionRecord> => {
  assertCreativeId(input.creativeId);

  const existing = await readRecord(input.creativeId);
  const now = new Date().toISOString();
  const record: CreativeAttributionRecord = {
    version: 1,
    creativeId: input.creativeId,
    mediaId: input.mediaId,
    fileName: input.fileName,
    creativeUrl: input.creativeUrl,
    source: input.source,
    category: input.category,
    format: input.format,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    meta: {
      adAccountId: input.adAccountId,
      campaignId: input.campaignId,
      adSetId: input.adSetId,
      metaAdId: input.metaAdId,
      metaCreativeId: input.metaCreativeId,
      metaImageHash: input.metaImageHash,
      publishedAt: now,
    },
  };

  await writeRecord(record);
  return record;
};
