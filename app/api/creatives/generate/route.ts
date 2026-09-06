import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import {
  analyzeTraSourceCreative,
  generateApprovedTraReferenceCreativeImage,
  generateCreativeCopy,
  type CreativeReferenceAnalysis,
} from '@/lib/ai/openai';
import {
  analyzeApprovedTraVideoFrames,
  generateApprovedTraVideoFrameCreativeImage,
} from '@/lib/ai/video-frame-generation';
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
import type { GeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import {
  formatLayoutBlueprintForPlanning,
  type LayoutBlueprint,
} from '@/lib/layouts/blueprint';
import {
  getOrAnalyzeLayoutBlueprint,
  type ResolvedLayoutBlueprint,
} from '@/lib/layouts/service';
import { getMediaStorage } from '@/lib/media/local-storage';
import {
  CreativeSourceHydrationError,
  findEligibleProviderImageSource,
  hydrateCreativeSourceSelections,
  type HydratedCreativeSourceAsset,
} from '@/lib/media/source-hydration';
import { isUsableApprovedHumanSource } from '@/lib/media/types';
import { listReferenceLibrary } from '@/lib/references/storage';
import type { ReferenceLibraryItem } from '@/lib/references/types';
import { TraVideoProcessingError } from '@/lib/video/ffmpeg';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import {
  loadVideoFrameLibrary,
  videoSourceHash,
} from '@/lib/video/library-service';
import { getApprovedSelectedTraVideoFrames } from '@/lib/video/selected-frames';
import { getApprovedTraVideoFrames } from '@/lib/video/tra-video-frames';
import type { ApprovedTraVideoFrameSet } from '@/lib/video/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const RENDER_CONCURRENCY = 2;

const encodeSseEvent = (
  encoder: TextEncoder,
  event: 'creative' | 'error' | 'complete',
  payload: object
) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);

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
    'people, faces, spokespersons, or human figures without an attached approved TRA human source',
  ],
  unknowns: [],
  dominantCategory: plan[0]?.category || 'customer-problems',
});

const buildLayoutReferenceAnalysis = (
  blueprint: LayoutBlueprint,
  plan: PlannedCreative[]
): CreativeReferenceAnalysis => ({
  summary:
    'External layout reference reduced to a validated design-only LayoutBlueprint. It supplies no creative strategy, copy, claims, brand identity, trademark identity, or person identity.',
  visibleText: [],
  visualStructure: formatLayoutBlueprintForPlanning(blueprint),
  hookOrAngle:
    'Not supplied by the layout reference. Choose strategy only from approved TRA company context and user direction.',
  offerOrCta:
    'Not supplied by the layout reference. Use only approved TRA offers, claims, and CTA direction.',
  styleNotes:
    'Use only the validated blueprint geometry and controlled design mechanisms. Do not reconstruct restricted reference content.',
  preserve: ['validated layout geometry and design mechanisms only'],
  avoid: [
    'third-party person identity',
    'third-party logos or branding',
    'third-party trademarks',
    'reference ad copy',
    'reference testimonials, statistics, claims, or proof content',
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
- Do not depict a person, face, spokesperson, or human figure. No approved TRA human identity is attached to this image-generation call, so use a non-human concept.
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
      quality: 'high',
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

const buildPlanFromSelectedReferences = (
  request: ValidGenerateCreativeRequest,
  selections: SelectedReferenceCreative[]
): PlannedCreative[] =>
  selections.map((selection, offset) => {
    const [template] = buildCreativePlan(
      { ...request, variationCount: 1 },
      selection.item.angle
    );
    return { ...template, index: offset + 1 };
  });

const findGenerationSource = (
  sources: HydratedCreativeSourceAsset[]
): HydratedCreativeSourceAsset | undefined =>
  sources.find(
    (source) =>
      source.role === 'LAYOUT_REFERENCE' && source.media.mediaType === 'IMAGE'
  ) || sources.find((source) => source.media.mediaType === 'IMAGE');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = validateGenerateCreativeRequest(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    if (
      parsed.data.videoFrameSelection &&
      process.env.NODE_ENV === 'production'
    ) {
      return NextResponse.json(
        { error: 'Selected TRA video frame generation is available in local development only.' },
        { status: 404 }
      );
    }

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: 'OpenAI generation is not configured yet.' },
        { status: 503 }
      );
    }

    const storage = getMediaStorage();
    let sourceAssets: HydratedCreativeSourceAsset[];
    try {
      sourceAssets = await hydrateCreativeSourceSelections(
        storage,
        parsed.data.sourceAssets
      );
    } catch (error) {
      if (error instanceof CreativeSourceHydrationError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.status }
        );
      }
      throw error;
    }

    const generationSourceAsset = findGenerationSource(sourceAssets);
    const source =
      generationSourceAsset?.stored.mediaType === 'IMAGE'
        ? generationSourceAsset.stored
        : null;
    const providerImageSource = findEligibleProviderImageSource(sourceAssets);
    const traVideoSource = sourceAssets.find(
      (sourceAsset) => sourceAsset.role === 'TRA_VIDEO'
    ) as HydratedTraVideoSource | undefined;
    let videoFrameSet: ApprovedTraVideoFrameSet | null = null;
    let generatedVideoFrameSelection: GeneratedVideoFrameSelection | undefined;

    if (parsed.data.videoFrameSelection && traVideoSource) {
      const requestedSelection = parsed.data.videoFrameSelection;
      const sourceContentHash = videoSourceHash(traVideoSource);
      if (sourceContentHash !== requestedSelection.sourceVideoContentHash) {
        return NextResponse.json(
          { error: 'The selected TRA video frames are stale. Reanalyze the video and select frames again.' },
          { status: 409 }
        );
      }
      const library = await loadVideoFrameLibrary(
        traVideoSource.media.id,
        sourceContentHash
      );
      if (!library) {
        return NextResponse.json(
          { error: 'The selected TRA video frame library is missing or invalid. Reanalyze the video and select frames again.' },
          { status: 409 }
        );
      }
      if (library.id !== requestedSelection.libraryId) {
        return NextResponse.json(
          { error: 'The selected TRA video frame library does not match this request. Select frames again.' },
          { status: 409 }
        );
      }
      try {
        const selectedFrameSet = await getApprovedSelectedTraVideoFrames(
          traVideoSource,
          library,
          requestedSelection.frameIds
        );
        videoFrameSet = selectedFrameSet;
        generatedVideoFrameSelection = {
          libraryId: library.id,
          sourceVideoMediaId: traVideoSource.media.id,
          sourceVideoContentHash: selectedFrameSet.sourceVideoContentHash,
          frames: selectedFrameSet.selectionProvenance,
        };
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? error.message
                : 'The selected TRA video frames could not be verified. Select frames again.',
          },
          { status: 409 }
        );
      }
    } else if (traVideoSource && !providerImageSource) {
      try {
        videoFrameSet = await getApprovedTraVideoFrames(traVideoSource);
      } catch (error) {
        if (error instanceof TraVideoProcessingError) {
          return NextResponse.json(
            { error: error.message },
            { status: error.status }
          );
        }
        throw error;
      }
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
    let layoutBlueprint: ResolvedLayoutBlueprint | null = null;
    let selectedReferences: SelectedReferenceCreative[] = [];
    let librarySelections = new Map<number, SelectedReferenceCreative>();

    if (source && generationSourceAsset?.role === 'LAYOUT_REFERENCE') {
      layoutBlueprint = await getOrAnalyzeLayoutBlueprint(source);
      creativePlan = buildCreativePlan(parsed.data);
      analysis = buildLayoutReferenceAnalysis(layoutBlueprint.blueprint, creativePlan);
    } else if (source && generationSourceAsset?.role === 'TRA_REFERENCE') {
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
      selectedReferences = chosen;
      creativePlan = buildPlanFromSelectedReferences(parsed.data, selectedReferences);
      librarySelections = new Map(
        selectedReferences.map((selection, index) => [index + 1, selection])
      );
    } else if (videoFrameSet) {
      analysis = await analyzeApprovedTraVideoFrames({
        frames: videoFrameSet.frames,
        context: parsed.data.context,
      });
      creativePlan = buildCreativePlan(parsed.data);
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
      ? generationSourceAsset?.role === 'TRA_REFERENCE'
        ? 'TRA ad mode: AI has selected one individual library reference for each requested creative. Each output must be a separate TRA adaptation of its own single reference. Never combine, merge, collage, or borrow visual systems from multiple references. The validated uploaded TRA reference may be the only raw image attached to final generation; library references are analysis-only.'
        : 'Layout-reference mode: the uploaded external image has already been reduced to a validated structured LayoutBlueprint. Use only that design mechanism plus approved TRA context. Its raw pixels and any person identity in it must never reach final image generation.'
      : videoFrameSet
        ? `Video-source mode: the raw TRA video ${videoFrameSet.source.media.id} remains server-side and is never attached to the image provider. A bounded set of server-extracted approved still frames is available as TRA human/content source pixels. Do not treat old video framing, captions, or graphics as a required static-ad layout.`
        : 'No-image mode: create original TRA ads from the user direction.';

    const approvedHumanSource =
      providerImageSource || videoFrameSet?.source || null;
    const sourceSuppliedToImageGeneration = Boolean(
      providerImageSource || videoFrameSet?.frames.length
    );
    const hasUsableApprovedHumanSource = approvedHumanSource
      ? isUsableApprovedHumanSource(
          approvedHumanSource,
          sourceSuppliedToImageGeneration
        )
      : false;
    const humanSourceDirection = videoFrameSet
      ? `Use only a person visibly grounded in the attached approved TRA video frames from source ${videoFrameSet.source.media.id}. Preserve that visible identity; do not invent, replace, blend, or add another person. Layout-reference and library-reference people remain forbidden human sources.`
      : hasUsableApprovedHumanSource
        ? 'Use only the attached approved TRA human identity when depicting a person.'
        : 'Current generation boundary: no approved TRA human source is attached to final image generation. Do not depict any person, face, spokesperson, body, or human figure; use a non-human visual concept. Layout-reference and library-reference people are never approved human sources.';

    const colorDirection = parsed.data.brandColors?.length
      ? `Approved TRA brand palette from the uploaded logo: ${parsed.data.brandColors.join(', ')}. Use these as the primary design colors. Neutral black, white, and gray may be used for legibility, but do not substitute an unrelated dominant palette.`
      : '';
    const fontDirection = parsed.data.brandFontNames?.length
      ? `Approved typography guidance derived from actual uploaded TRA font files:\n${parsed.data.brandFontNames.map((font) => `- ${font}`).join('\n')}\nUse these descriptions to match the approved typography character as closely as the image model allows. Do not introduce a conflicting type style just because it appears in a third-party reference image.`
      : '';
    const brandDirection = [colorDirection, fontDirection]
      .filter(Boolean)
      .join('\n\n');

    const analysisDirection = source
      ? `Analysis-only source guidance (raw layout/library pixels are not attached unless the source is the validated TRA reference explicitly allowed at the final provider boundary):\nSummary: ${analysis.summary}\nVisual structure: ${analysis.visualStructure}\nStyle notes: ${analysis.styleNotes}\nPreserve at a high level: ${analysis.preserve.join('; ') || 'none'}\nAvoid: ${analysis.avoid.join('; ') || 'none'}`
      : videoFrameSet
        ? `Approved TRA video-frame source analysis:\nSummary: ${analysis.summary}\nVisible source structure/context: ${analysis.visualStructure}\nStyle notes: ${analysis.styleNotes}\nPreserve approved TRA cues: ${analysis.preserve.join('; ') || 'none'}\nAvoid: ${analysis.avoid.join('; ') || 'none'}`
        : '';

    const generationContext = `${parsed.data.context}\n\n${modeDirection}\n\n${humanSourceDirection}${brandDirection ? `\n\nTRA brand system:\n${brandDirection}` : ''}${analysisDirection ? `\n\n${analysisDirection}` : ''}\n\nPrimary creative categories:\n${categoryDirections}${referenceDirections ? `\n\nSingle-reference assignments:\n${referenceDirections}` : ''}\n\nTreat each assigned reference as separate analysis-only creative guidance. Do not blend references.`;

    const copyByIndex = await generateCreativeCopy(
      creativePlan,
      generationContext,
      analysis
    );
    const renderCreative = async (item: PlannedCreative): Promise<GeneratedCreative> => {
          const copy = copyByIndex.get(item.index);
          if (!copy) {
            throw new Error(`Missing copy for creative ${item.index}.`);
          }

          const selectedReference = librarySelections.get(item.index);
          const singleReferenceContract = selectedReference
            ? `\n\nANALYSIS-ONLY SINGLE-REFERENCE GUIDANCE:\n- Selected external reference: ${selectedReference.item.id} (${CREATIVE_CATEGORY_LABELS[selectedReference.item.angle]}).\n- Its raw pixels are NOT attached to final generation.\n- Use only its category and AI selection reason as high-level direction; do not claim or recreate an exact unseen blueprint.\n- Do NOT combine it with another ad style, another reference, a collage, extra panels, unrelated decorative systems, or multiple competing concepts.\n- Preserve one dominant visual idea. Simpler is better.\n- Do not copy third-party identity or unsupported claims.\n- AI selection reason: ${selectedReference.selectionReason}`
            : '';
          const itemContext = `${parsed.data.context}${videoFrameSet ? `\n\n${modeDirection}` : ''}\n\n${humanSourceDirection}${brandDirection ? `\n\nTRA brand system:\n${brandDirection}` : ''}${analysisDirection ? `\n\n${analysisDirection}` : ''}\nPrimary category: ${CREATIVE_CATEGORY_LABELS[item.category]}. Treat this category as the main ad idea; use the format only as its presentation structure.${singleReferenceContract}`;
          let imageBuffer: Buffer;

          if (providerImageSource) {
            imageBuffer = await generateApprovedTraReferenceCreativeImage({
              source: providerImageSource.stored,
              primaryFormat: item.format,
              context: itemContext,
              copy,
              reserveLogoArea,
            });
          } else if (videoFrameSet) {
            imageBuffer = await generateApprovedTraVideoFrameCreativeImage({
              frames: videoFrameSet.frames,
              primaryFormat: item.format,
              context: itemContext,
              copy,
              reserveLogoArea,
            });
          } else {
            imageBuffer = await generatePromptOnlyCreativeImage({
              primaryFormat: item.format,
              context: itemContext,
              copy,
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
            generationSourceAsset?.role === 'LAYOUT_REFERENCE'
              ? generationSourceAsset.media.id
              : undefined;

          return {
            id: `creative_${randomUUID().replaceAll('-', '')}`,
            index: item.index,
            category: item.category,
            format: item.format,
            image,
            copy,
            ...(generatedVideoFrameSelection
              ? { videoFrameSelection: generatedVideoFrameSelection }
              : {}),
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
    };

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const successfulIndexes: number[] = [];
        const failedIndexes: number[] = [];
        let cursor = 0;

        const emit = (
          event: 'creative' | 'error' | 'complete',
          payload: object
        ) => controller.enqueue(encodeSseEvent(encoder, event, payload));

        const worker = async () => {
          while (true) {
            const position = cursor;
            cursor += 1;
            if (position >= creativePlan.length) return;

            const item = creativePlan[position];
            try {
              const creative = await renderCreative(item);
              successfulIndexes.push(item.index);
              emit('creative', { creative });
            } catch (error) {
              console.error(`Creative ${item.index} failed to render`, error);
              failedIndexes.push(item.index);
              emit('error', {
                index: item.index,
                error: `Creative ${item.index} could not be generated.`,
              });
            }
          }
        };

        try {
          await Promise.all(
            Array.from(
              { length: Math.min(RENDER_CONCURRENCY, creativePlan.length) },
              () => worker()
            )
          );
          successfulIndexes.sort((a, b) => a - b);
          failedIndexes.sort((a, b) => a - b);
          emit('complete', {
            requestedCount: creativePlan.length,
            successfulCount: successfulIndexes.length,
            failedCount: failedIndexes.length,
            successfulIndexes,
            failedIndexes,
          });
        } catch (error) {
          console.error('Creative generation stream failed', error);
          emit('error', {
            error: 'Creative generation was interrupted before completion.',
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Creative generation failed', error);
    return NextResponse.json(
      { error: 'Creative generation failed. Check the server configuration and try again.' },
      { status: 500 }
    );
  }
}
