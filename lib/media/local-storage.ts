import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { resolve } from 'path';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  getMediaTypeForMimeType,
  type CreativeSourceMediaAsset,
  type MediaAsset,
  type StoredCreativeSourceMediaFile,
  type StoredMediaFile,
} from '@/lib/media/types';
import {
  EXTENSION_BY_MIME,
  getStoredMediaMimeType,
  getStoredImageMimeType,
  isSafeMediaId,
  MIME_BY_EXTENSION,
  prepareMedia,
  prepareMediaImage,
  type MediaStorage,
} from '@/lib/media/storage';
import { R2MediaStorage } from '@/lib/media/r2-storage';

export class LocalMediaStorage implements MediaStorage {
  private readonly root = (() => {
    const configuredRoot = process.env.MEDIA_STORAGE_DIR;
    return configuredRoot
      ? resolve(/* turbopackIgnore: true */ process.cwd(), configuredRoot)
      : resolve(process.cwd(), 'data', 'uploads');
  })();

  private async write(fileName: string, buffer: Buffer) {
    await mkdir(this.root, { recursive: true });
    await writeFile(resolve(this.root, fileName), buffer, { flag: 'wx' });
  }

  async saveMedia(file: File): Promise<CreativeSourceMediaAsset> {
    const { buffer, ...media } = await prepareMedia(file);
    await this.write(media.fileName, buffer);
    return media;
  }

  async saveImage(file: File): Promise<MediaAsset> {
    const { buffer, ...media } = await prepareMediaImage(file);
    await this.write(media.fileName, buffer);
    return media;
  }

  async readMedia(
    fileName: string
  ): Promise<StoredCreativeSourceMediaFile | null> {
    const mimeType = getStoredMediaMimeType(fileName);
    if (!mimeType) return null;

    try {
      return {
        fileName,
        buffer: await readFile(resolve(this.root, fileName)),
        mimeType,
        mediaType: getMediaTypeForMimeType(mimeType),
      } as StoredCreativeSourceMediaFile;
    } catch {
      return null;
    }
  }

  async readImage(fileName: string): Promise<StoredMediaFile | null> {
    if (!getStoredImageMimeType(fileName)) return null;
    const stored = await this.readMedia(fileName);
    if (!stored || stored.mediaType !== 'IMAGE') return null;
    const { mediaType: _mediaType, ...image } = stored;
    return image;
  }

  private async readById(
    mediaId: string,
    extensions: string[]
  ): Promise<StoredCreativeSourceMediaFile | null> {
    if (!isSafeMediaId(mediaId)) return null;

    for (const extension of extensions) {
      const stored = await this.readMedia(`${mediaId}.${extension}`);
      if (stored) return stored;
    }
    return null;
  }

  async readMediaById(mediaId: string) {
    return this.readById(mediaId, Object.keys(MIME_BY_EXTENSION));
  }

  async readImageById(mediaId: string): Promise<StoredMediaFile | null> {
    const stored = await this.readById(
      mediaId,
      ALLOWED_IMAGE_MIME_TYPES.map((mimeType) => EXTENSION_BY_MIME[mimeType])
    );
    if (!stored || stored.mediaType !== 'IMAGE') return null;
    const { mediaType: _mediaType, ...image } = stored;
    return image;
  }

  async deleteImage(fileName: string): Promise<void> {
    if (!getStoredImageMimeType(fileName)) return;

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
  if (storage) return storage;

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
