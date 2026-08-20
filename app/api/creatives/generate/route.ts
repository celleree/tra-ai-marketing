import { NextResponse } from 'next/server';
import {
  analyzeReferenceCreative,
  generateCreativeCopy,
} from '@/lib/ai/openai';
import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import {
  buildCreativePlan,
  validateGenerateCreativeRequest,
} from '@/lib/creatives/generate-request';
import { getMediaStorage } from '@/lib/media/local-storage';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
  let stage = 'reading request';

  try {
    const body = await request.json();
    stage = 'validating request';
    const parsed = validateGenerateCreativeRequest(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: 'OpenAI generation is not configured yet.' },
        { status: 503 }
      );
    }

    stage = 'loading source image';
    const source = await getMediaStorage().readImageById(parsed.data.mediaId);
    if (!source) {
      return NextResponse.json(
        { error: 'The source image could not be found.' },
        { status: 404 }
      );
    }

    stage = 'building creative plan';
    const creativePlan = buildCreativePlan(parsed.data);
    const categoryDirections = creativePlan
      .map(
        (item) =>
          `Variation ${item.index}: ${CREATIVE_CATEGORY_LABELS[item.category]}`
      )
      .join('\n');
    const generationContext = `${parsed.data.context}\n\nPrimary creative categories:\n${categoryDirections}\n\nTreat each category as the main messaging direction. The format is only the presentation structure.`;

    stage = 'analyzing reference image';
    const analysis = await analyzeReferenceCreative(source, generationContext);

    stage = 'generating ad copy';
    const copyByIndex = await generateCreativeCopy(
      creativePlan,
      generationContext,
      analysis
    );

    stage = 'finalizing creative plan';
    const preparedCreatives = creativePlan.map((item) => {
      const copy = copyByIndex.get(item.index);
      if (!copy) {
        throw new Error(`Missing copy for variation ${item.index}.`);
      }

      return {
        index: item.index,
        category: item.category,
        format: item.format,
        copy,
      };
    });

    return NextResponse.json({
      mediaId: parsed.data.mediaId,
      context: parsed.data.context,
      analysis,
      preparedCreatives,
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : 'Unknown creative generation error.';

    console.error(`Creative planning failed during ${stage}`, error);

    if (process.env.VERCEL_ENV === 'preview') {
      return NextResponse.json(
        {
          error: 'Creative planning failed.',
          stage,
          detail,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: 'Creative planning failed. Check the server configuration and try again.' },
      { status: 500 }
    );
  }
}
