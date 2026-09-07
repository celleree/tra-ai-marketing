import { parseGeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import { NextResponse } from 'next/server';
import { isCreativeCategory } from '@/lib/creative-categories';
import { isCreativeFormat } from '@/lib/creative-formats';
import type { CreativeRecord } from '@/lib/creatives/generated';
import { parseCreativePlanning } from '@/lib/creatives/planning-metadata';
import { parseCreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import { parseCreativeIdentity } from '@/lib/creatives/identity';
import { isCreativePlacement } from '@/lib/creatives/placements';
import {
  isSafeCreativeId,
  listCreatives,
  saveCreativeBatch,
} from '@/lib/creatives/storage';
import { getCreativeAttribution } from '@/lib/creatives/attribution';
import { getMediaStorage } from '@/lib/media/local-storage';
import type { MediaAsset } from '@/lib/media/types';
import {
  getPublicMediaUrl,
  getStoredImageMimeType,
  isAllowedImageMimeType,
  isSafeMediaId,
} from '@/lib/media/storage';

export const runtime = 'nodejs';

const normalizeMediaAsset = (value: unknown): MediaAsset | null => {
  if (!value || typeof value !== 'object') return null;
  const image = value as Record<string, unknown>;
  const id = typeof image.id === 'string' ? image.id : '';
  const fileName = typeof image.fileName === 'string' ? image.fileName : '';
  const originalName =
    typeof image.originalName === 'string' ? image.originalName.slice(0, 200) : '';
  const mimeType = typeof image.mimeType === 'string' ? image.mimeType : '';
  const size = typeof image.size === 'number' ? image.size : Number(image.size);

  if (
    !isSafeMediaId(id) ||
    !getStoredImageMimeType(fileName) ||
    !fileName.startsWith(`${id}.`) ||
    !isAllowedImageMimeType(mimeType) ||
    !Number.isFinite(size) ||
    size <= 0
  ) {
    return null;
  }

  return {
    id,
    fileName,
    originalName,
    mimeType,
    size,
    url: getPublicMediaUrl(fileName),
  };
};

const normalizeCreative = (
  value: unknown,
  createdAt: string
): CreativeRecord | null => {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const copy =
    input.copy && typeof input.copy === 'object'
      ? (input.copy as Record<string, unknown>)
      : null;
  const id = typeof input.id === 'string' ? input.id : '';
  const category = typeof input.category === 'string' ? input.category : '';
  const image = normalizeMediaAsset(input.image);
  const primaryText =
    typeof copy?.primaryText === 'string' ? copy.primaryText.trim() : '';
  const headline = typeof copy?.headline === 'string' ? copy.headline.trim() : '';
  const description =
    typeof copy?.description === 'string' ? copy.description.trim() : '';
  const source = input.source === undefined ? 'generated' : input.source;
  const videoFrameSelection = parseGeneratedVideoFrameSelection(input.videoFrameSelection);
  const planning = parseCreativePlanning(input.planning);
  const generationProvenance = parseCreativeGenerationProvenance(input.generationProvenance);
  const identity = parseCreativeIdentity(input.identity, id);
  const format =
    typeof input.format === 'string' && isCreativeFormat(input.format)
      ? input.format
      : undefined;
  const placement = isCreativePlacement(input.placement)
    ? input.placement
    : undefined;
  const referenceImageId =
    typeof input.referenceImageId === 'string'
      ? input.referenceImageId
      : undefined;

  if (
    !isSafeCreativeId(id) ||
    !image ||
    !isCreativeCategory(category) ||
    !primaryText ||
    !headline ||
    (source !== 'generated' && source !== 'uploaded') ||
    (input.format !== undefined && !format) ||
    (input.placement !== undefined && !placement) ||
    (referenceImageId !== undefined && !isSafeMediaId(referenceImageId))
    || (input.videoFrameSelection !== undefined && !videoFrameSelection)
    || (input.planning !== undefined && !planning)
    || (input.generationProvenance !== undefined && !generationProvenance)
    || (input.identity !== undefined && !identity)
  ) {
    return null;
  }

  return {
    id,
    createdAt,
    image,
    category,
    copy: { primaryText, headline, description },
    source,
    ...(format ? { format } : {}),
    ...(placement ? { placement } : {}),
    ...(referenceImageId ? { referenceImageId } : {}),
    ...(videoFrameSelection ? { videoFrameSelection } : {}),
    ...(planning ? { planning } : {}),
    ...(generationProvenance ? { generationProvenance } : {}),
    ...(identity ? { identity } : {}),
  };
};

export async function GET() {
  try {
    const records = await listCreatives();
    const items = await Promise.all(
      records.map(async (record) => {
        const attribution = await getCreativeAttribution(record.id);
        return {
          ...record,
          ...(attribution?.meta?.metaAdId
            ? { metaAdId: attribution.meta.metaAdId }
            : {}),
          ...(attribution?.meta?.metaCreativeId
            ? { metaCreativeId: attribution.meta.metaCreativeId }
            : {}),
        };
      })
    );
    return NextResponse.json({ items });
  } catch (error) {
    console.error('Could not load TRA creatives', error);
    return NextResponse.json(
      { error: 'TRA creatives could not be loaded.' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json(
        { error: 'Request body must be a JSON object.' },
        { status: 400 }
      );
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: 'Request body must contain valid JSON.' },
      { status: 400 }
    );
  }

  try {
    if (!Array.isArray(body.creatives)) {
      return NextResponse.json(
        { error: 'creatives must be an array.' },
        { status: 400 }
      );
    }
    const rawCreatives = body.creatives;
    if (!rawCreatives.length || rawCreatives.length > 30) {
      return NextResponse.json(
        { error: 'Save between 1 and 30 completed creatives.' },
        { status: 400 }
      );
    }

    const createdAt = new Date().toISOString();
    const records = rawCreatives.map((creative) =>
      normalizeCreative(creative, createdAt)
    );
    if (records.some((record) => !record)) {
      return NextResponse.json(
        { error: 'One or more completed creatives were invalid.' },
        { status: 400 }
      );
    }

    const validRecords = records as CreativeRecord[];
    const storage = getMediaStorage();
    const storedImages = await Promise.all(
      validRecords.map((record) => storage.readImageById(record.image.id))
    );
    if (
      storedImages.some(
        (image, index) =>
          !image ||
          image.fileName !== validRecords[index].image.fileName ||
          image.mimeType !== validRecords[index].image.mimeType
      )
    ) {
      return NextResponse.json(
        { error: 'One or more final creative images could not be found.' },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { items: await saveCreativeBatch(validRecords) },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const duplicate = message.includes('already exists') || message.includes('unique');
    console.error('Could not save TRA creatives', error);
    return NextResponse.json(
      { error: duplicate ? message : 'TRA creatives could not be saved.' },
      { status: duplicate ? 409 : 500 }
    );
  }
}
