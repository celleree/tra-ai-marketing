import { NextResponse } from 'next/server';
import {
  generateReferenceCreativeImage,
  type CreativeReferenceAnalysis,
} from '@/lib/ai/openai';
import {
  CREATIVE_CATEGORY_LABELS,
  isCreativeCategory,
  type CreativeCategoryId,
} from '@/lib/creative-categories';
import {
  isCreativeFormat,
  type CreativeFormatId,
} from '@/lib/creative-formats';
import type { CreativeCopy, GeneratedCreative } from '@/lib/creatives/generated';
import { getMediaStorage } from '@/lib/media/local-storage';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface PreparedCreative {
  index: number;
  category: CreativeCategoryId;
  format: CreativeFormatId;
  copy: CreativeCopy;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const parseAnalysis = (value: unknown): CreativeReferenceAnalysis | null => {
  if (!value || typeof value !== 'object') return null;
  const analysis = value as Record<string, unknown>;
  const stringFields = [
    'summary',
    'visualStructure',
    'hookOrAngle',
    'offerOrCta',
    'styleNotes',
  ] as const;

  if (stringFields.some((field) => typeof analysis[field] !== 'string')) {
    return null;
  }

  if (
    !isStringArray(analysis.visibleText) ||
    !isStringArray(analysis.preserve) ||
    !isStringArray(analysis.avoid) ||
    !isStringArray(analysis.unknowns)
  ) {
    return null;
  }

  return analysis as unknown as CreativeReferenceAnalysis;
};

const parsePreparedCreative = (value: unknown): PreparedCreative | null => {
  if (!value || typeof value !== 'object') return null;
  const creative = value as Record<string, unknown>;
  const index =
    typeof creative.index === 'number' ? creative.index : Number(creative.index);
  const category = typeof creative.category === 'string' ? creative.category : '';
  const format = typeof creative.format === 'string' ? creative.format : '';
  const copy = creative.copy;

  if (
    !Number.isInteger(index) ||
    index < 1 ||
    index > 30 ||
    !isCreativeCategory(category) ||
    !isCreativeFormat(format) ||
    !copy ||
    typeof copy !== 'object'
  ) {
    return null;
  }

  const copyRecord = copy as Record<string, unknown>;
  if (
    typeof copyRecord.primaryText !== 'string' ||
    typeof copyRecord.headline !== 'string' ||
    typeof copyRecord.description !== 'string'
  ) {
    return null;
  }

  return {
    index,
    category,
    format,
    copy: {
      primaryText: copyRecord.primaryText,
      headline: copyRecord.headline,
      description: copyRecord.description,
    },
  };
};

export async function POST(request: Request) {
  let stage = 'reading render request';

  try {
    const body = (await request.json()) as Record<string, unknown>;
    stage = 'validating render request';

    const mediaId = typeof body.mediaId === 'string' ? body.mediaId.trim() : '';
    const context = typeof body.context === 'string' ? body.context.trim() : '';
    const analysis = parseAnalysis(body.analysis);
    const prepared = parsePreparedCreative(body.creative);

    if (!mediaId || !context || !analysis || !prepared) {
      return NextResponse.json(
        { error: 'The creative render request is invalid.' },
        { status: 400 }
      );
    }

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: 'OpenAI generation is not configured yet.' },
        { status: 503 }
      );
    }

    stage = `loading source image for variation ${prepared.index}`;
    const storage = getMediaStorage();
    const source = await storage.readImageById(mediaId);
    if (!source) {
      return NextResponse.json(
        { error: 'The source image could not be found.' },
        { status: 404 }
      );
    }

    stage = `rendering variation ${prepared.index}`;
    const imageBuffer = await generateReferenceCreativeImage({
      source,
      primaryFormat: prepared.format,
      context: `${context}\nPrimary category: ${CREATIVE_CATEGORY_LABELS[prepared.category]}. Treat this category as the main ad idea; use the format only as its presentation structure.`,
      copy: prepared.copy,
      analysis,
    });

    stage = `saving variation ${prepared.index}`;
    const generatedFile = new File(
      [new Uint8Array(imageBuffer)],
      `tra-creative-${prepared.index}.png`,
      { type: 'image/png' }
    );
    const image = await storage.saveImage(generatedFile);

    const creative: GeneratedCreative = {
      index: prepared.index,
      category: prepared.category,
      format: prepared.format,
      image,
      copy: prepared.copy,
    };

    return NextResponse.json({ creative });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : 'Unknown creative rendering error.';

    console.error(`Creative rendering failed during ${stage}`, error);

    if (process.env.VERCEL_ENV === 'preview') {
      return NextResponse.json(
        {
          error: 'Creative rendering failed.',
          stage,
          detail,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: 'Creative rendering failed. Check the server configuration and try again.' },
      { status: 500 }
    );
  }
}
