import { NextResponse } from 'next/server';
import {
  analyzeReferenceCreative,
  analyzeTraSourceCreative,
  generateCreativeCopy,
  generateReferenceCreativeImage,
  generateTraCreativeFromLibraryReference,
  type CreativeReferenceAnalysis,
} from '@/lib/ai/openai';
import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import { CREATIVE_FORMAT_LABELS } from '@/lib/creative-formats';
import {
  buildCreativePlan,
  validateGenerateCreativeRequest,
  type PlannedCreative,
} from '@/lib/creatives/generate-request';
import type { GeneratedCreative, CreativeCopy } from '@/lib/creatives/generated';
import { getMediaStorage } from '@/lib/media/local-storage';
import type { MediaStorage } from '@/lib/media/storage';
import type { StoredMediaFile } from '@/lib/media/types';
import { listReferenceLibrary } from '@/lib/references/storage';
import type { ReferenceLibraryItem } from '@/lib/references/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

interface SelectedLibraryReference {
  item: ReferenceLibraryItem;
  source: StoredMediaFile;
}

const getOpenAIError = async (response: Response) => {
  try {
    const payload = (await response.json()) as {
      error?: { message?: string };
    };
    return payload.error?.message || `OpenAI request failed with ${response.status}.`;
  } catch {
    return `OpenAI request failed with ${response.status}.`;
  }
};

const buildPromptOnlyAnalysis = (
  context: string,
  plan: PlannedCreative[]
): CreativeReferenceAnalysis => ({
  summary: 'No source image was supplied. Create original TRA concepts from the user direction.',
  visibleText: [],
  visualStructure: 'Choose an original mobile-first static ad composition appropriate to the assigned category and format.',
  hookOrAngle: context,
  offerOrCta: 'Use only claims and calls to action supported by the user direction and TRA guardrails.',
  styleNotes: 'Original TRA creative. Clear hierarchy, strong readability, and no dependence on a source image.',
  preserve: [],
  avoid: [
    'invented testimonials',
    'unsupported statistics',
    'guaranteed outcomes',
    'government affiliation',
    'third-party brands or trademarks',
  ],
  unknowns: [],
  dominantCategory: plan[0]?.category || 'customer-problems',
});

const generatePromptOnlyCreativeImage = async (args: {
  primaryFormat: keyof typeof CREATIVE_FORMAT_LABELS;
  context: string;
  copy: CreativeCopy;
}) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  const prompt = `
Create an ORIGINAL square static Facebook/Instagram ad for Tax Relief Advocates (TRA).

Primary creative format: ${CREATIVE_FORMAT_LABELS[args.primaryFormat]}
User direction: ${args.context}

Use this approved ad copy as the messaging source:
Headline: ${args.copy.headline}
Primary text idea: ${args.copy.primaryText}
Description: ${args.copy.description}

TRA guardrails:
- This request has no reference image. Invent the visual composition from scratch.
- Do not invent a testimonial, review quote, statistic, dollar amount, customer outcome, expert endorsement, government affiliation, competitor claim, or guarantee.
- If the assigned format normally relies on evidence that is not supplied, preserve the format concept without inventing the evidence.
- Do not imply universal tax-debt results.
- Keep the design credible, consumer-friendly, and readable on a phone.
- Use strong visual hierarchy and avoid tiny text or clutter.
- The only company or brand name that may appear is Tax Relief Advocates or TRA.
`;

  const response = await fetch(`${OPENAI_BASE_URL}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      size: '1024x1024',
      quality: 'medium',
      output_format: 'png',
    }),
  });

  if (!response.ok) {
    throw new Error(await getOpenAIError(response));
  }

  const payload = (await response.json()) as {
    data?: Array<{ b64_json?: string }>;
  };
  const base64 = payload.data?.[0]?.b64_json;
  if (!base64) {
    throw new Error('OpenAI returned no generated image.');
  }

  return Buffer.from(base64, 'base64');
};

const selectLibraryReferences = async (
  plan: PlannedCreative[],
  storage: MediaStorage,
  library: ReferenceLibraryItem[]
): Promise<Map<number, SelectedLibraryReference>> => {
  const selections = new Map<number, SelectedLibraryReference>();
  if (!library.length) return selections;

  const rotation = Math.floor(Math.random() * library.length);
  const orderedLibrary = [
    ...library.slice(rotation),
    ...library.slice(0, rotation),
  ];
  const usedIds = new Set<string>();
  const sourceCache = new Map<string, Promise<StoredMediaFile | null>>();

  const readSource = (id: string) => {
    const existing = sourceCache.get(id);
    if (existing) return existing;
    const pending = storage.readImageById(id);
    sourceCache.set(id, pending);
    return pending;
  };

  for (const creative of plan) {
    const groups = [
      orderedLibrary.filter(
        (item) => item.angle === creative.category && !usedIds.has(item.id)
      ),
      orderedLibrary.filter((item) => !usedIds.has(item.id)),
      orderedLibrary.filter((item) => item.angle === creative.category),
      orderedLibrary,
    ];
    const seen = new Set<string>();
    const candidates = groups
      .flat()
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });

    for (const candidate of candidates) {
      const source = await readSource(candidate.id);
      if (!source) continue;
      selections.set(creative.index, { item: candidate, source });
      usedIds.add(candidate.id);
      break;
    }
  }

  return selections;
};

export async function POST(request: Request) {
  try {
    const body = await request.json();
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

    const storage = getMediaStorage();
    const source = parsed.data.mediaId
      ? await storage.readImageById(parsed.data.mediaId)
      : null;

    if (parsed.data.mediaId && !source) {
      return NextResponse.json(
        { error: 'The source image could not be found.' },
        { status: 404 }
      );
    }

    let analysis: CreativeReferenceAnalysis;
    let creativePlan: PlannedCreative[];

    if (source && parsed.data.uploadMode === 'reference') {
      analysis = await analyzeReferenceCreative(source, parsed.data.context);
      creativePlan = buildCreativePlan(parsed.data, analysis.dominantCategory);
    } else {
      creativePlan = buildCreativePlan(parsed.data);
      analysis = source
        ? await analyzeTraSourceCreative(source, parsed.data.context)
        : buildPromptOnlyAnalysis(parsed.data.context, creativePlan);
    }

    const categoryDirections = creativePlan
      .map(
        (item) =>
          `Variation ${item.index}: ${CREATIVE_CATEGORY_LABELS[item.category]}`
      )
      .join('\n');
    const modeDirection = source
      ? parsed.data.uploadMode === 'tra'
        ? 'TRA ad mode: the uploaded image is the TRA brand/content anchor. Use the reference library for fresh creative execution and do not repeat the uploaded ad layout.'
        : `Reference ad mode: the uploaded image is creative inspiration. Keep the variations within its dominant category (${CREATIVE_CATEGORY_LABELS[analysis.dominantCategory]}) while turning the concept into original TRA ads.`
      : 'No-image mode: create original TRA ads from the user direction.';
    const generationContext = `${parsed.data.context}\n\n${modeDirection}\n\nPrimary creative categories:\n${categoryDirections}\n\nTreat each category as the main messaging direction. The format is only the presentation structure.`;

    let librarySelections = new Map<number, SelectedLibraryReference>();
    if (source && parsed.data.uploadMode === 'tra') {
      const library = await listReferenceLibrary();
      librarySelections = await selectLibraryReferences(
        creativePlan,
        storage,
        library
      );

      if (librarySelections.size !== creativePlan.length) {
        return NextResponse.json(
          {
            error:
              'TRA ad mode needs at least one usable image in the Reference Images library. Add or re-upload a reference image and try again.',
          },
          { status: 409 }
        );
      }
    }

    const copyByIndex = await generateCreativeCopy(
      creativePlan,
      generationContext,
      analysis
    );
    const creatives: GeneratedCreative[] = [];

    for (let offset = 0; offset < creativePlan.length; offset += 2) {
      const batch = creativePlan.slice(offset, offset + 2);
      const generated = await Promise.all(
        batch.map(async (item): Promise<GeneratedCreative> => {
          const copy = copyByIndex.get(item.index);
          if (!copy) {
            throw new Error(`Missing copy for variation ${item.index}.`);
          }

          const itemContext = `${parsed.data.context}\nPrimary category: ${CREATIVE_CATEGORY_LABELS[item.category]}. Treat this category as the main ad idea; use the format only as its presentation structure.`;
          let imageBuffer: Buffer;

          if (!source) {
            imageBuffer = await generatePromptOnlyCreativeImage({
              primaryFormat: item.format,
              context: itemContext,
              copy,
            });
          } else if (parsed.data.uploadMode === 'reference') {
            imageBuffer = await generateReferenceCreativeImage({
              source,
              primaryFormat: item.format,
              context: itemContext,
              copy,
              analysis,
            });
          } else {
            const selectedReference = librarySelections.get(item.index);
            if (!selectedReference) {
              throw new Error(
                `Missing library reference for variation ${item.index}.`
              );
            }
            imageBuffer = await generateTraCreativeFromLibraryReference({
              traSource: source,
              creativeReference: selectedReference.source,
              primaryFormat: item.format,
              context: itemContext,
              copy,
              traAnalysis: analysis,
            });
          }

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

    creatives.sort((a, b) => a.index - b.index);
    return NextResponse.json({
      creatives,
      creativePlan,
      analysis,
      uploadMode: source ? parsed.data.uploadMode : null,
      usedReferenceImage: Boolean(source),
      referenceLibrarySelections: Array.from(librarySelections.entries()).map(
        ([index, selection]) => ({
          index,
          referenceId: selection.item.id,
          referenceCategory: selection.item.angle,
        })
      ),
    });
  } catch (error) {
    console.error('Creative generation failed', error);
    return NextResponse.json(
      { error: 'Creative generation failed. Check the server configuration and try again.' },
      { status: 500 }
    );
  }
}
