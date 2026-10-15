import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
  getMaxUploadBytes,
  getStoredMediaMimeType,
  getStoredImageMimeType,
  isSafeMediaId,
  MediaValidationError,
  MIME_BY_EXTENSION,
  prepareMedia,
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
    (('name' in error &&
      (error.name === 'NoSuchKey' || error.name === 'NotFound')) ||
      ('Code' in error && error.Code === 'NoSuchKey') ||
      ('code' in error && error.code === 'NoSuchKey') ||
      ('$metadata' in error &&
        typeof error.$metadata === 'object' &&
        error.$metadata !== null &&
        'httpStatusCode' in error.$metadata &&
        error.$metadata.httpStatusCode === 404)));

const validateContentLength = (
  fileName: string,
  mimeType: ReturnType<typeof getStoredMediaMimeType>,
  contentLength: number | undefined
) => {
  if (!mimeType) return;
  if (
    !Number.isFinite(contentLength) ||
    contentLength === undefined ||
    contentLength < 0 ||
    !Number.isInteger(contentLength)
  ) {
    throw new MediaValidationError(
      `R2 returned an invalid content length for media object ${fileName}.`
    );
  }

  if (contentLength > getMaxUploadBytes(mimeType)) {
    throw new MediaValidationError(
      `The ${getMediaTypeForMimeType(mimeType) === 'VIDEO' ? 'video' : 'image'} is larger than the upload limit.`
    );
  }
};

const discardUnreadBody = async (body: unknown) => {
  if (!body || typeof body !== 'object') return;

  try {
    if ('destroy' in body && typeof body.destroy === 'function') {
      body.destroy();
      return;
    }
    if ('cancel' in body && typeof body.cancel === 'function') {
      await body.cancel();
    }
  } catch {
    // Keep the validation failure as the observable error.
  }
};

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

  private async put(fileName: string, mimeType: string, buffer: Buffer) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileName,
        Body: buffer,
        ContentType: mimeType,
      })
    );
  }

  async saveMedia(file: File): Promise<CreativeSourceMediaAsset> {
    const { buffer, ...media } = await prepareMedia(file);
    await this.put(media.fileName, media.mimeType, buffer);
    return media;
  }

  async saveImage(file: File): Promise<MediaAsset> {
    const { buffer, ...media } = await prepareMediaImage(file);
    await this.put(media.fileName, media.mimeType, buffer);
    return media;
  }

  async getMediaDeliveryUrl(fileName: string): Promise<string | null> {
    const mimeType = getStoredMediaMimeType(fileName);
    if (!mimeType) return null;

    try {
      const metadata = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: fileName })
      );
      validateContentLength(fileName, mimeType, metadata.ContentLength);

      return getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucketName, Key: fileName }),
        { expiresIn: 60 }
      );
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }

  async readMedia(
    fileName: string
  ): Promise<StoredCreativeSourceMediaFile | null> {
    const mimeType = getStoredMediaMimeType(fileName);
    if (!mimeType) return null;

    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: fileName })
      );
      if (!response.Body) {
        throw new Error(`R2 returned an empty body for media object ${fileName}.`);
      }

      try {
        validateContentLength(fileName, mimeType, response.ContentLength);
      } catch (error) {
        await discardUnreadBody(response.Body);
        throw error;
      }

      return {
        fileName,
        buffer: Buffer.from(await response.Body.transformToByteArray()),
        mimeType,
        mediaType: getMediaTypeForMimeType(mimeType),
      } as StoredCreativeSourceMediaFile;
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
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
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucketName, Key: fileName })
    );
  }
}
