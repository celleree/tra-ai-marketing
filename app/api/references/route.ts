import { NextResponse } from 'next/server';
import type { MediaAsset } from '@/lib/media/types';
import {
  getStoredImageMimeType,
  isAllowedImageMimeType,
  isSafeMediaId,
} from '@/lib/media/storage';
import {
  addToReferenceLibrary,
  listReferenceLibrary,
} from '@/lib/references/storage';

export const runtime = 'nodejs';

const normalizeMediaAsset = (value: unknown): MediaAsset | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;

  const id = typeof item.id === 'string' ? item.id : '';
  const fileName = typeof item.fileName === 'string' ? item.fileName : '';
  const originalName =
    typeof item.originalName === 'string' ? item.originalName.slice(0, 200) : 'reference';
  const mimeType = typeof item.mimeType === 'string' ? item.mimeType : '';
  const size = typeof item.size === 'number' ? item.size : Number(item.size);

  if (!isSafeMediaId(id)) return null;
  if (!getStoredImageMimeType(fileName)) return null;
  if (!fileName.startsWith(`${id}.`)) return null;
  if (!isAllowedImageMimeType(mimeType)) return null;
  if (!Number.isFinite(size) || size <= 0) return null;

  return {
    id,
    fileName,
    originalName,
    mimeType,
    size,
    url: `/api/media/files/${fileName}`,
  };
};

export async function GET() {
  try {
    return NextResponse.json({ items: await listReferenceLibrary() });
  } catch (error) {
    console.error('Could not load reference library', error);
    return NextResponse.json(
      { error: 'The reference library could not be loaded.' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const rawItems = Array.isArray(body.items) ? body.items : [];

    if (!rawItems.length) {
      return NextResponse.json(
        { error: 'Add at least one reference image.' },
        { status: 400 }
      );
    }

    if (rawItems.length > 100) {
      return NextResponse.json(
        { error: 'Upload no more than 100 reference images at a time.' },
        { status: 400 }
      );
    }

    const items = rawItems
      .map(normalizeMediaAsset)
      .filter((item): item is MediaAsset => Boolean(item));

    if (items.length !== rawItems.length) {
      return NextResponse.json(
        { error: 'One or more reference images were invalid.' },
        { status: 400 }
      );
    }

    return NextResponse.json({ items: await addToReferenceLibrary(items) });
  } catch (error) {
    console.error('Could not update reference library', error);
    return NextResponse.json(
      { error: 'The reference library could not be updated.' },
      { status: 500 }
    );
  }
}
