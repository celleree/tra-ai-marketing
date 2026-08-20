import { NextResponse } from 'next/server';
import { getMediaStorage } from '@/lib/media/local-storage';
import {
  MediaValidationError,
  validateStoredMediaImage,
} from '@/lib/media/storage';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const mediaId = typeof body.mediaId === 'string' ? body.mediaId : '';

    if (!mediaId) {
      return NextResponse.json({ error: 'mediaId is required.' }, { status: 400 });
    }

    const stored = await getMediaStorage().readImageById(mediaId);
    if (!stored) {
      return NextResponse.json({ error: 'Uploaded image was not found.' }, { status: 404 });
    }

    validateStoredMediaImage(stored);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof MediaValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error('Direct upload confirmation failed', error);
    return NextResponse.json(
      { error: 'The uploaded image could not be validated.' },
      { status: 500 }
    );
  }
}
