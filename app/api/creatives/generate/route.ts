import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import {
  analyzeReferenceCreative,
  analyzeTraSourceCreative,
  generateCreativeCopy,
  generateReferenceCreativeImage,
  generateTraCreativeFromLibraryReference,
  type CreativeReferenceAnalysis,
} from '@/lib/ai/openai';
import {
  selectBestReferenceCreatives,
  type ReferenceSelectionCandidate,
  type SelectedReferenceCreative,
} from '@/lib/ai/reference-selector';
import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import { CREATIVE_FORMAT_LABELS } from '@/lib/creative-formats';
import {
  buildCreativePlan,
  validateGenerateCreativeRequest,
  type PlannedCreative,
  type ValidGenerateCreativeRequest,
} from '@/lib/creatives/generate-request';
import type { GeneratedCreative, CreativeCopy } from '@/lib/creatives/generated';
import { getMediaStorage } from '@/lib/media/local-storage';
import type { StoredMediaFile } from '@/lib/media/types';
import { listReferenceLibrary } from '@/lib/references/storage';
import type { ReferenceLibraryItem } from '@/lib/references/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

interface SelectedLibraryReference extends SelectedReferenceCreative {
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
  reserveLogoArea: boolean;
}) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  const logoDirection = args.reserveLogoArea
    ? `
Approved-logo placement:
- Do NOT draw, imitate, typeset, or invent a TRA logo in the generated image.
- Leave the upper-left area clear of important text, faces, CTA buttons, and essential imagery: approximately the left 27% of the canvas and top 13% of the canvas.
- The exact approved TRA logo asset will be composited into that reserved space after image generation.
`
    : '';
  const prompt = `
Create an ORIGINAL square static Facebook/Instagram ad for Tax Relief Advocates (TRA).

Primary creative format: ${CREATIVE_FORMAT_LABELS[args.primaryFormat]}
User direction: ${args.context}

Use this approved ad copy as the messaging source:
Headline: ${args.copy.headline}
Primary text idea: ${args.copy.primaryText}
Description: ${args.copy.description}

${logoDirection}
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

const buildReferenceCandidates = (
  library: ReferenceLibraryItem[],
  requestUrl: string
): ReferenceSelectionCandidate[] =>
  library.map((item) => ({
    item,
    imageUrl: new URL(item.url, requestUrl).toString(),
  }));

const hydrateSelectedReferences = async (
  selections: SelectedReferenceCreative[]
): Promise<SelectedLibraryReference[]> => {
  const storage = getMediaStorage();
  const hydrated: SelectedLibraryReference[] = [];

  for (const selection of selections) {
    const source = await storage.readImageById(selection.item.id);
    if (!source) {
      throw new Error(
        `Selected reference ${selection.item.id} could not be loaded from media storage.`
      );
    }
    hydrated.push({ ...selection, source });
  }

  return hydrated;
};

const buildPlanFromSelectedReferences = (
  request: ValidGenerateCreativeRequest,
  selections: SelectedLibraryReference[]
): PlannedCreative[] =>
  selections.map((selection, offset) => {
    const [template] = buildCreativePlan(
      { ...request, variationCount: 1 },
      selection.item.angle
    );
    return { ...template, index: offset + 1 };
  });

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

    const brandLogo = parsed.data.brandLogoMediaId
      ? await storage.readImageById(parsed.data.brandLogoMediaId)
      : null;
    if (parsed.data.brandLogoMediaId && !brandLogo) {
      return NextResponse.json(
        {
          error:
            'The saved TRA logo could not be found. Re-upload the logo in Company > Brand Guidelines and try again.',
        },
        { status: 404 }
      );
    }
    const reserveLogoArea = Boolean(brandLogo);

    let analysis: CreativeReferenceAnalysis;
    let creativePlan: PlannedCreative[];
    let selectedReferences: SelectedLibraryReference[] = [];
    let librarySelections = new Map<number, SelectedLibraryReference>();

    if (source && parsed.data.uploadMode === 'reference') {
      analysis = await analyzeReferenceCreative(source, parsed.data.context);
      creativePlan = buildCreativePlan(parsed.data, analysis.dominantCategory);
    } else if (source && parsed.data.uploadMode === 'tra') {
      analysis = await analyzeTraSourceCreative(source, parsed.data.context);

      const library = await listReferenceLibrary();
      if (library.length < parsed.data.variationCount) {
        return NextResponse.json(
          {
            error: `TRA ad mode needs at least ${parsed.data.variationCount} reference images to create ${parsed.data.variationCount} separate reference remakes. Only ${library.length} are currently available.`,
          },
          { status: 409 }
        );
      }

      const chosen = await selectBestReferenceCreatives({
        candidates: buildReferenceCandidates(library, request.url),
        requestedCount: parsed.data.variationCount,
        userContext: parsed.data.context,
        traSummary: analysis.summary,
        traPreserve: analysis.preserve,
      });
      selectedReferences = await hydrateSelectedReferences(chosen);
      creativePlan = buildPlanFromSelectedReferences(parsed.data, selectedReferences);
      librarySelections = new Map(
        selectedReferences.map((selection, index) => [index + 1, selection])
      );
    } else {
      creativePlan = buildCreativePlan(parsed.data);
      analysis = buildPromptOnlyAnalysis(parsed.data.context, creativePlan);
    }

    const categoryDirections = creativePlan
      .map(
        (item) =>
          `Creative ${item.index}: ${CREATIVE_CATEGORY_LABELS[item.category]}`
      )
      .join('\n');
    const referenceDirections = selectedReferences.length
      ? selectedReferences
          .map(
            (selection, index) =>
              `Creative ${index + 1}: use ONLY reference ${selection.item.id} (${CREATIVE_CATEGORY_LABELS[selection.item.angle]}). Selection reason: ${selection.selectionReason}`
          )
          .join('\n')
      : '';
    const modeDirection = source
      ? parsed.data.uploadMode === 'tra'
        ? 'TRA ad mode: AI has selected one individual library reference for each requested creative. Each output must be a separate TRA adaptation of its own single reference. Never combine, merge, collage, or borrow visual systems from multiple references. The uploaded TRA image supplies brand/content context through analysis only and is not passed into final image generation.'
        : `Reference ad mode: the uploaded image is creative inspiration. Keep the variations within its dominant category (${CREATIVE_CATEGORY_LABELS[analysis.dominantCategory]}) while turning the concept into original TRA ads.`
      : 'No-image mode: create original TRA ads from the user direction.';

    const colorDirection = parsed.data.brandColors?.length
      ? `Approved TRA brand palette from the uploaded logo: ${parsed.data.brandColors.join(', ')}. Use these as the primary design colors. Neutral black, white, and gray may be used for legibility, but do not substitute an unrelated dominant palette.`
      : '';
    const fontDirection = parsed.data.brandFontNames?.length
      ? `Approved typography guidance derived from actual uploaded TRA font files:\n${parsed.data.brandFontNames.map((font) => `- ${font}`).join('\n')}\nUse these descriptions to match the approved typography character as closely as the image model allows. Do not introduce a conflicting type style just because it appears in a third-party reference image.`
      : '';
    const brandDirection = [colorDirection, fontDirection]
      .filter(Boolean)
      .join('\n\n');

    const generationContext = `${parsed.data.context}\n\n${modeDirection}${brandDirection ? `\n\nTRA brand system:\n${brandDirection}` : ''}\n\nPrimary creative categories:\n${categoryDirections}${referenceDirections ? `\n\nSingle-reference assignments:\n${referenceDirections}` : ''}\n\nTreat each assigned reference as a separate creative blueprint. Do not blend references.`;

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
            throw new Error(`Missing copy for creative ${item.index}.`);
          }

          const selectedReference = librarySelections.get(item.index);
          const singleReferenceContract = selectedReference
            ? `\n\nSINGLE-REFERENCE EXECUTION CONTRACT:\n- The attached image is the ONLY creative reference for this output.\n- Recreate one clean TRA version of THIS reference's composition, hierarchy, spacing, and main visual mechanism.\n- Do NOT combine it with another ad style, another reference, a collage, extra panels, unrelated decorative systems, or multiple competing concepts.\n- Preserve one dominant visual idea. Simpler is better.\n- If the reference does not contain an element, do not invent a second ad concept to fill space.\n- Adapt third-party branding/content into TRA branding and approved TRA copy without copying protected identity or unsupported claims.\n- AI selection reason: ${selectedReference.selectionReason}`
            : '';
          const itemContext = `${parsed.data.context}${brandDirection ? `\n\nTRA brand system:\n${brandDirection}` : ''}\nPrimary category: ${CREATIVE_CATEGORY_LABELS[item.category]}. Treat this category as the main ad idea; use the format only as its presentation structure.${singleReferenceContract}`;
          let imageBuffer: Buffer;

          if (!source) {
            imageBuffer = await generatePromptOnlyCreativeImage({
              primaryFormat: item.format,
              context: itemContext,
              copy,
              reserveLogoArea,
            });
          } else if (parsed.data.uploadMode === 'reference') {
            imageBuffer = await generateReferenceCreativeImage({
              source,
              primaryFormat: item.format,
              context: itemContext,
              copy,
              analysis,
              reserveLogoArea,
            });
          } else {
            if (!selectedReference) {
              throw new Error(
                `Missing AI-selected library reference for creative ${item.index}.`
              );
            }

            imageBuffer = await generateTraCreativeFromLibraryReference({
              creativeReference: selectedReference.source,
              primaryFormat: item.format,
              context: itemContext,
              copy,
              traAnalysis: analysis,
              reserveLogoArea,
            });
          }

          const generatedFile = new File(
            [new Uint8Array(imageBuffer)],
            `tra-creative-${item.index}.png`,
            { type: 'image/png' }
          );
          const image = await storage.saveImage(generatedFile);
          const uploadedReferenceImageId =
            parsed.data.uploadMode === 'reference'
              ? parsed.data.mediaId
              : undefined;

          return {
            id: `creative_${randomUUID().replaceAll('-', '')}`,
            index: item.index,
            category: item.category,
            format: item.format,
            image,
            copy,
            ...(selectedReference
              ? {
                  referenceImageId: selectedReference.item.id,
                  referenceImageUrl: selectedReference.item.url,
                  referenceCategory: selectedReference.item.angle,
                  referenceSelectionReason: selectedReference.selectionReason,
                }
              : uploadedReferenceImageId
                ? { referenceImageId: uploadedReferenceImageId }
              : {}),
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
      usedBrandLogo: reserveLogoArea,
      usedBrandColors: parsed.data.brandColors?.length || 0,
      usedBrandFonts: parsed.data.brandFontNames?.length || 0,
      referenceSelectionMode:
        source && parsed.data.uploadMode === 'tra' ? 'ai-single-reference' : null,
      referenceLibrarySelections: Array.from(librarySelections.entries()).map(
        ([index, selection]) => ({
          index,
          referenceId: selection.item.id,
          referenceUrl: selection.item.url,
          referenceCategory: selection.item.angle,
          selectionReason: selection.selectionReason,
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
