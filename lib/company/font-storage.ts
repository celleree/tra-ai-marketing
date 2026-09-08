import { randomUUID } from 'crypto';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { resolve } from 'path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  MAX_BRAND_FONT_BYTES,
  getBrandFontMimeType,
  isSafeBrandFontFileName,
  type BrandFontAsset,
  type BrandFontMimeType,
} from '@/lib/company/brand-fonts';
import {
  BrandFontValidationError,
  validateBrandFontBuffer,
} from '@/lib/company/font-validation.server';

export { BrandFontValidationError } from '@/lib/company/font-validation.server';

const R2_PREFIX = '_brand/fonts/';
const LOCAL_ROOT = resolve(process.cwd(), 'data/brand-fonts');

export interface StoredBrandFontFile {
  fileName: string;
  buffer: Buffer;
  mimeType: BrandFontMimeType;
}

const isMissingObjectError = (error: unknown) =>
  error instanceof NoSuchKey ||
  (typeof error === 'object' &&
    error !== null &&
    (('name' in error && error.name === 'NoSuchKey') ||
      ('Code' in error && error.Code === 'NoSuchKey') ||
      ('code' in error && error.code === 'NoSuchKey')));

const getR2Client = () => {
  const required = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
  ] as const;
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`R2 brand font configuration is incomplete. Missing: ${missing.join(', ')}`);
  }

  return {
    bucketName: process.env.R2_BUCKET_NAME!,
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

const prepareBrandFont = async (file: File) => {
  const mimeType = getBrandFontMimeType(file.name);
  if (!mimeType) {
    throw new BrandFontValidationError('Upload a WOFF2, WOFF, TTF, or OTF font file.');
  }
  if (!file.size || file.size > MAX_BRAND_FONT_BYTES) {
    throw new BrandFontValidationError('Font files must be 4 MB or smaller.');
  }

  const extension = file.name.split('.').pop()!.toLowerCase();
  const id = `font_${randomUUID().replaceAll('-', '')}`;
  const fileName = `${id}.${extension}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  validateBrandFontBuffer(buffer, mimeType);

  const asset: BrandFontAsset = {
    id,
    fileName,
    originalName: file.name.slice(0, 200),
    mimeType,
    size: buffer.byteLength,
    url: `/api/company/fonts/${fileName}`,
  };

  return { asset, buffer };
};

export async function saveBrandFont(file: File): Promise<BrandFontAsset> {
  const { asset, buffer } = await prepareBrandFont(file);

  if (process.env.NODE_ENV === 'production') {
    const { client, bucketName } = getR2Client();
    await client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: `${R2_PREFIX}${asset.fileName}`,
        Body: buffer,
        ContentType: asset.mimeType,
      })
    );
  } else {
    await mkdir(LOCAL_ROOT, { recursive: true });
    await writeFile(resolve(LOCAL_ROOT, asset.fileName), buffer, { flag: 'wx' });
  }

  return asset;
}

export async function readBrandFont(
  fileName: string
): Promise<StoredBrandFontFile | null> {
  if (!isSafeBrandFontFileName(fileName)) return null;
  const mimeType = getBrandFontMimeType(fileName);
  if (!mimeType) return null;

  if (process.env.NODE_ENV === 'production') {
    const { client, bucketName } = getR2Client();
    try {
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucketName, Key: `${R2_PREFIX}${fileName}` })
      );
      if (!response.Body) return null;
      return {
        fileName,
        mimeType,
        buffer: Buffer.from(await response.Body.transformToByteArray()),
      };
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }

  try {
    return {
      fileName,
      mimeType,
      buffer: await readFile(resolve(LOCAL_ROOT, fileName)),
    };
  } catch {
    return null;
  }
}

export async function deleteBrandFont(fileName: string): Promise<void> {
  if (!isSafeBrandFontFileName(fileName)) return;

  if (process.env.NODE_ENV === 'production') {
    const { client, bucketName } = getR2Client();
    await client.send(
      new DeleteObjectCommand({ Bucket: bucketName, Key: `${R2_PREFIX}${fileName}` })
    );
    return;
  }

  try {
    await unlink(resolve(LOCAL_ROOT, fileName));
  } catch {
    // A missing local font is already effectively removed.
  }
}
