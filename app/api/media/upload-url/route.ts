import { randomUUID } from 'crypto';
import { basename } from 'path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NextResponse } from 'next/server';
import type { MediaAsset } from '@/lib/media/types';
import {
  EXTENSION_BY_MIME,
  getMaxUploadBytes,
  isAllowedImageMimeType,
} from '@/lib/media/storage';

export const runtime = 'nodejs';

const REQUIRED_R2_VARIABLES = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
] as const;

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== 'production') {
    return NextResponse.json({ direct: false });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const originalName =
      typeof body.fileName === 'string' ? basename(body.fileName).slice(0, 200) : 'upload';
    const mimeType = typeof body.mimeType === 'string' ? body.mimeType : '';
    const size = typeof body.size === 'number' ? body.size : Number(body.size);

    if (!isAllowedImageMimeType(mimeType)) {
      return NextResponse.json(
        { error: 'Upload a PNG, JPEG, or WebP image.' },
        { status: 400 }
      );
    }

    if (!Number.isFinite(size) || size <= 0 || size > getMaxUploadBytes()) {
      return NextResponse.json(
        { error: 'The image is empty or larger than the upload limit.' },
        { status: 400 }
      );
    }

    const missing = REQUIRED_R2_VARIABLES.filter((name) => !process.env[name]);
    if (missing.length) {
      throw new Error(`R2 configuration is incomplete. Missing: ${missing.join(', ')}`);
    }

    const id = `media_${randomUUID().replaceAll('-', '')}`;
    const fileName = `${id}.${EXTENSION_BY_MIME[mimeType]}`;
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });

    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: fileName,
        ContentType: mimeType,
      }),
      {
        expiresIn: 300,
        signableHeaders: new Set(['content-type']),
      }
    );

    const media: MediaAsset = {
      id,
      fileName,
      originalName,
      mimeType,
      size,
      url: `/api/media/files/${fileName}`,
    };

    return NextResponse.json({ direct: true, uploadUrl, media });
  } catch (error) {
    console.error('Could not create direct upload URL', error);
    return NextResponse.json(
      { error: 'The upload could not be prepared.' },
      { status: 500 }
    );
  }
}
