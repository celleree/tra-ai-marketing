import { NextResponse } from 'next/server';
import { getMediaStorage } from '@/lib/media/local-storage';
import { validateSourceRoleForMime } from '@/lib/media/source-contract';
import {
  MediaValidationError,
  validateStoredMedia,
} from '@/lib/media/storage';
import { requireOperatorAccess } from '@/lib/auth/require-operator';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const denied = await requireOperatorAccess();
  if (denied) return denied;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const mediaId = typeof body.mediaId === 'string' ? body.mediaId : '';
    if (!mediaId) {
      return NextResponse.json({ error: 'mediaId is required.' }, { status: 400 });
    }

    const stored = await getMediaStorage().readMediaById(mediaId);
    if (!stored) {
      return NextResponse.json(
        { error: 'Uploaded file was not found.' },
        { status: 404 }
      );
    }
    validateStoredMedia(stored);

    const hasSourceMetadata =
      body.sourceRole !== undefined ||
      body.mimeType !== undefined ||
      body.mediaType !== undefined;
    if (stored.mediaType === 'VIDEO' || hasSourceMetadata) {
      const sourceContract = validateSourceRoleForMime(
        body.sourceRole,
        body.mimeType ?? stored.mimeType
      );
      if (!sourceContract.success) {
        return NextResponse.json(
          { error: sourceContract.error },
          { status: 400 }
        );
      }

      if (
        sourceContract.data.mimeType !== stored.mimeType ||
        sourceContract.data.mediaType !== stored.mediaType ||
        (body.mediaType !== undefined && body.mediaType !== stored.mediaType)
      ) {
        return NextResponse.json(
          { error: 'The uploaded media metadata does not match the stored file.' },
          { status: 400 }
        );
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof MediaValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error('Direct upload confirmation failed', error);
    return NextResponse.json(
      { error: 'The uploaded file could not be validated.' },
      { status: 500 }
    );
  }
}
