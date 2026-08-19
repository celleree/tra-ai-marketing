import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { MediaAsset, StoredMediaFile } from '@/lib/media/types';
import {
  getStoredImageMimeType,
  isSafeMediaId,
  MIME_BY_EXTENSION,
  prepareMediaImage,
  type MediaStorage,
} from '@/lib/media/storage';

interface R2MediaStorageConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

const isMissingObjectError = (error: unknown) =>
  error instanceof NoSuchKey ||
  (typeof error === 'object' &&
    error !== null &&
    (('name' in error && error.name === 'NoSuchKey') ||
      ('Code' in error && error.Code === 'NoSuchKey') ||
      ('code' in error && error.code === 'NoSuchKey')));

export class R2MediaStorage implements MediaStorage {
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor(config: R2MediaStorageConfig) {
    this.bucketName = config.bucketName;
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async saveImage(file: File): Promise<MediaAsset> {
    const { buffer, ...media } = await prepareMediaImage(file);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: media.fileName,
        Body: buffer,
        ContentType: media.mimeType,
      })
    );

    return media;
  }

  async readImage(fileName: string): Promise<StoredMediaFile | null> {
    const mimeType = getStoredImageMimeType(fileName);
    if (!mimeType) {
      return null;
    }

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: fileName,
        })
      );

      if (!response.Body) {
        throw new Error(`R2 returned an empty body for media object ${fileName}.`);
      }

      const buffer = Buffer.from(await response.Body.transformToByteArray());
      return { fileName, buffer, mimeType };
    } catch (error) {
      if (isMissingObjectError(error)) {
        return null;
      }
      throw error;
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
}
