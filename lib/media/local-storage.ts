import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { resolve } from 'path';
import type { MediaAsset, StoredMediaFile } from '@/lib/media/types';
import {
  getStoredImageMimeType,
  isSafeMediaId,
  MIME_BY_EXTENSION,
  prepareMediaImage,
  type MediaStorage,
} from '@/lib/media/storage';
import { R2MediaStorage } from '@/lib/media/r2-storage';

export class LocalMediaStorage implements MediaStorage {
  private readonly root = resolve(
    process.cwd(),
    process.env.MEDIA_STORAGE_DIR || 'data/uploads'
  );

  async saveImage(file: File): Promise<MediaAsset> {
    const { buffer, ...media } = await prepareMediaImage(file);

    await mkdir(this.root, { recursive: true });
    await writeFile(resolve(this.root, media.fileName), buffer, { flag: 'wx' });

    return media;
  }

  async readImage(fileName: string): Promise<StoredMediaFile | null> {
    const mimeType = getStoredImageMimeType(fileName);
    if (!mimeType) {
      return null;
    }

    try {
      const buffer = await readFile(resolve(this.root, fileName));
      return { fileName, buffer, mimeType };
    } catch {
      return null;
    }
  }

  async readImageById(mediaId: string): Promise<StoredMediaFile | null> {
    if (!isSafeMediaId(mediaId)) {
      return null;
    }

    for (const extension of Object.keys(MIME_BY_EXTENSION)) {
      const stored = await this.readImage(`${mediaId}.${extension}`);
      if (stored) {
        return stored;
      }
    }

    return null;
  }

  async deleteImage(fileName: string): Promise<void> {
    if (!getStoredImageMimeType(fileName)) {
      return;
    }

    try {
      await unlink(resolve(this.root, fileName));
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }
  }
}

let storage: MediaStorage | undefined;

const REQUIRED_R2_VARIABLES = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
] as const;

export const getMediaStorage = (): MediaStorage => {
  if (storage) {
    return storage;
  }

  if (process.env.NODE_ENV !== 'production') {
    storage = new LocalMediaStorage();
    return storage;
  }

  const missingVariables = REQUIRED_R2_VARIABLES.filter(
    (name) => !process.env[name]
  );
  if (missingVariables.length) {
    throw new Error(
      `R2 media storage configuration is incomplete. Missing: ${missingVariables.join(', ')}`
    );
  }

  storage = new R2MediaStorage({
    accountId: process.env.R2_ACCOUNT_ID!,
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    bucketName: process.env.R2_BUCKET_NAME!,
  });
  return storage;
};
