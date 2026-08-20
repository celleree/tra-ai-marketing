import { NextResponse } from 'next/server';
import {
  analyzeReferenceCreative,
  generateCreativeCopy,
  generateReferenceCreativeImage,
} from '@/lib/ai/openai';
import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import {
  buildCreativePlan,
  validateGenerateCreativeRequest,
} from '@/lib/creatives/generate-request';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import { getMediaStorage } from '@/lib/media/local-storage';

export const runtime = 'nodejs';
export const maxDuration = 300;

const IMAGE_BATCH_SIZE = 5;

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
    const storage = getMediaStorage();
    const source = await storage.readImageById(parsed.data.mediaId);
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
    const creatives: GeneratedCreative[] = [];

    for (let offset = 0; offset < creativePlan.length; offset += IMAGE_BATCH_SIZE) {
      const batch = creativePlan.slice(offset, offset + IMAGE_BATCH_SIZE);
      const firstIndex = batch[0]?.index ?? offset + 1;
      const lastIndex = batch.at(-1)?.index ?? firstIndex;
      stage = `generating images ${firstIndex}-${lastIndex}`;

      const generated = await Promise.all(
        batch.map(async (item): Promise<GeneratedCreative> => {
          const copy = copyByIndex.get(item.index);
          if (!copy) {
            throw new Error(`Missing copy for variation ${item.index}.`);
          }

          const imageBuffer = await generateReferenceCreativeImage({
            source,
            primaryFormat: item.format,
            context: `${parsed.data.context}\nPrimary category: ${CREATIVE_CATEGORY_LABELS[item.category]}. Treat this category as the main ad idea; use the format only as its presentation structure.`,
            copy,
            analysis,
          });
          const generatedFile = new File(
            [new Uint8Array(imageBuffer)],
            `tra-creative-${item.index}.png`,
            { type: 'image/png' }
          );
          const image = await storage.saveImage(generatedFile);

          return {
            index: item.index,
            category: item.category,
            format: item.format,
            image,
            copy,
          };
        })
      );

      creatives.push(...generated);
    }

    stage = 'finalizing response';
    creatives.sort((a, b) => a.index - b.index);
    return NextResponse.json({ creatives, creativePlan, analysis });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : 'Unknown creative generation error.';

    console.error(`Creative generation failed during ${stage}`, error);

    if (process.env.VERCEL_ENV === 'preview') {
      return NextResponse.json(
        {
          error: 'Creative generation failed.',
          stage,
          detail,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: 'Creative generation failed. Check the server configuration and try again.' },
      { status: 500 }
    );
  }
}
