import type { MediaAsset, StoredMediaFile } from '@/lib/media/types';

export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

export interface MediaStorage {
  saveImage(file: File): Promise<MediaAsset>;
  readImage(fileName: string): Promise<StoredMediaFile | null>;
  readImageById(mediaId: string): Promise<StoredMediaFile | null>;
}
