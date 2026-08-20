import { NextResponse } from 'next/server';
import { classifyReferenceCreativeAngle } from '@/lib/ai/reference-angle';
import {
  isCreativeCategory,
  type CreativeCategoryId,
} from '@/lib/creative-categories';
import { getMediaStorage } from '@/lib/media/local-storage';
import type { MediaAsset } from '@/lib/media/types';
import {
  getStoredImageMimeType,
  isAllowedImageMimeType,
  isSafeMediaId,
} from '@/lib/media/storage';
import {
  addToReferenceLibrary,
  listReferenceLibrary,
  removeFromReferenceLibrary,
  updateReferenceAngle,
  type ReferenceLibraryAddition,
} from '@/lib/references/storage';

export const runtime = 'nodejs';
export const maxDuration = 300;

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

const classifyReferences = async (
  items: MediaAsset[]
): Promise<ReferenceLibraryAddition[]> => {
  const storage = getMediaStorage();
  const results = new Array<ReferenceLibraryAddition>(items.length);
  let cursor = 0;

  const classifyOne = async (media: MediaAsset): Promise<ReferenceLibraryAddition> => {
    if (!process.env.OPENAI_API_KEY) {
      return {
        media,
        angle: 'customer-problems',
        angleSource: 'fallback',
      };
    }

    try {
      const source = await storage.readImageById(media.id);
      if (!source) {
        throw new Error('Uploaded reference could not be read for classification.');
      }

      return {
        media,
        angle: await classifyReferenceCreativeAngle(source),
        angleSource: 'ai',
      };
    } catch (error) {
      console.error(`Reference angle classification failed for ${media.id}`, error);
      return {
        media,
        angle: 'customer-problems',
        angleSource: 'fallback',
      };
    }
  };

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await classifyOne(items[index]);
    }
  };

  const workerCount = Math.min(3, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
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

    const classified = await classifyReferences(items);
    return NextResponse.json({ items: await addToReferenceLibrary(classified) });
  } catch (error) {
    console.error('Could not update reference library', error);
    return NextResponse.json(
      { error: 'The reference library could not be updated.' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const id = typeof body.id === 'string' ? body.id : '';
    const angle = typeof body.angle === 'string' ? body.angle : '';

    if (!isSafeMediaId(id)) {
      return NextResponse.json({ error: 'Invalid reference image.' }, { status: 400 });
    }

    if (!isCreativeCategory(angle)) {
      return NextResponse.json({ error: 'Invalid reference angle.' }, { status: 400 });
    }

    return NextResponse.json({
      items: await updateReferenceAngle(id, angle as CreativeCategoryId),
    });
  } catch (error) {
    console.error('Could not move reference image', error);
    return NextResponse.json(
      { error: 'The reference image could not be moved.' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const rawIds = Array.isArray(body.ids) ? body.ids : [];
    const ids = rawIds.filter(
      (value): value is string => typeof value === 'string' && isSafeMediaId(value)
    );

    if (!ids.length || ids.length !== rawIds.length) {
      return NextResponse.json(
        { error: 'Select at least one valid reference image.' },
        { status: 400 }
      );
    }

    if (ids.length > 100) {
      return NextResponse.json(
        { error: 'Delete no more than 100 reference images at a time.' },
        { status: 400 }
      );
    }

    const uniqueIds = [...new Set(ids)];
    const result = await removeFromReferenceLibrary(uniqueIds);
    const storage = getMediaStorage();
    const deletions = await Promise.allSettled(
      result.removed.map((item) => storage.deleteImage(item.fileName))
    );

    deletions.forEach((outcome, index) => {
      if (outcome.status === 'rejected') {
        console.error(
          `Could not delete stored reference ${result.removed[index]?.fileName}`,
          outcome.reason
        );
      }
    });

    return NextResponse.json({
      items: result.items,
      deleted: result.removed.length,
    });
  } catch (error) {
    console.error('Could not delete reference images', error);
    return NextResponse.json(
      { error: 'The selected reference images could not be deleted.' },
      { status: 500 }
    );
  }
}
