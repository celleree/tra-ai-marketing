import { createHash, randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { formatCreativeLogoReservation, formatCreativeSafeZoneRules } from '@/lib/creatives/safe-zones';
import { compositeCreativeBrandLogo } from '@/lib/creatives/brand-logo.server';
import { saveCreativeBatch } from '@/lib/creatives/storage';
import {
  analyzeTraSourceCreative,
  generateApprovedTraReferenceCreativeImage,
  type CreativeReferenceAnalysis,
} from '@/lib/ai/openai';
import type { ImageGenerationResult } from '@/lib/ai/image-generation-result';
import { planCreativeBatch } from '@/lib/ai/creative-planner';
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
  validateGenerateCreativeRequest,
} from '@/lib/creatives/generate-request';
import type { GeneratedCreative, CreativeCopy } from '@/lib/creatives/generated';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import type { CreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import { GeneratedImageValidationError, validateGeneratedCreativeImage } from '@/lib/creatives/generated-image-validation';
import { getCreativeDiversityIssue } from '@/lib/creatives/diversity';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import {
  CREATIVE_PLACEMENT_SPECS,
  type CreativePlacement,
} from '@/lib/creatives/placements';
import type { GeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import {
  formatLayoutBlueprintForPlanning,
  LAYOUT_BLUEPRINT_SCHEMA_VERSION,
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
import type {
  ApprovedTraVideoFrame,
  ApprovedTraVideoFrameSet,
} from '@/lib/video/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const RENDER_CONCURRENCY = 2;

const sha256 = (buffer: Buffer) =>
  createHash('sha256').update(buffer).digest('hex');

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
  context: string
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
  dominantCategory: 'customer-problems',
});

const buildLayoutReferenceAnalysis = (
  blueprint: LayoutBlueprint
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
  dominantCategory: 'customer-problems',
});

export const generatePromptOnlyCreativeImage = async (args: {
  primaryFormat: keyof typeof CREATIVE_FORMAT_LABELS;
  placement: CreativePlacement;
  context: string;
  copy: CreativeCopy;
  reserveLogoArea: boolean;
}): Promise<ImageGenerationResult> => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  const placement = CREATIVE_PLACEMENT_SPECS[args.placement];
  const logoDirection = args.reserveLogoArea ? formatCreativeLogoReservation(args.placement) : '';
  const prompt = `
Create an ORIGINAL ${placement.aspectRatio} static Facebook/Instagram ad for Tax Relief Advocates (TRA).

Compose natively for the ${placement.aspectRatio} canvas (${placement.width}x${placement.height}). Recompose the hierarchy, subject, copy, CTA, and logo space for this ratio; do not crop or stretch a square design.

Primary creative format: ${CREATIVE_FORMAT_LABELS[args.primaryFormat]}
User direction: ${args.context}

Use this approved ad copy as the messaging source:
Headline: ${args.copy.headline}
Primary text idea: ${args.copy.primaryText}
Description: ${args.copy.description}

${logoDirection}
${formatCreativeSafeZoneRules(args.placement)}
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
      size: placement.providerSize,
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

  return { buffer: Buffer.from(base64, 'base64'), prompt, model };
};

const buildReferenceCandidates = (
  library: ReferenceLibraryItem[],
  requestUrl: string
): ReferenceSelectionCandidate[] =>
  library.map((item) => ({
    item,
    imageUrl: new URL(item.url, requestUrl).toString(),
  }));

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
    const requestedSources: CreativeGenerationProvenance['requestedSources'] =
      sourceAssets.map((sourceAsset) => ({
        role: sourceAsset.role,
        mediaId: sourceAsset.media.id,
        sha256: sha256(sourceAsset.stored.buffer),
      }));
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
    const logoOverlaySource = brandLogo && parsed.data.brandLogoMediaId
      ? {
          mediaId: parsed.data.brandLogoMediaId,
          sha256: sha256(brandLogo.buffer),
        }
      : undefined;

    let analysis: CreativeReferenceAnalysis;
    let layoutBlueprint: ResolvedLayoutBlueprint | null = null;
    let selectedReferences: SelectedReferenceCreative[] = [];

    if (source && generationSourceAsset?.role === 'LAYOUT_REFERENCE') {
      layoutBlueprint = await getOrAnalyzeLayoutBlueprint(source);
      analysis = buildLayoutReferenceAnalysis(layoutBlueprint.blueprint);
    } else if (source && generationSourceAsset?.role === 'TRA_REFERENCE') {
      analysis = await analyzeTraSourceCreative(source, parsed.data.context);

      const library = await listReferenceLibrary();
      const requestedReferenceCount = Math.min(
        parsed.data.variationCount,
        library.length
      );
      if (requestedReferenceCount > 0) {
        selectedReferences = await selectBestReferenceCreatives({
          candidates: buildReferenceCandidates(library, request.url),
          requestedCount: requestedReferenceCount,
          userContext: parsed.data.context,
          traSummary: analysis.summary,
          traPreserve: analysis.preserve,
        });
      }
    } else if (videoFrameSet) {
      analysis = await analyzeApprovedTraVideoFrames({
        frames: videoFrameSet.frames,
        context: parsed.data.context,
      });
    } else {
      analysis = buildPromptOnlyAnalysis(parsed.data.context);
    }

    const referenceDirections = selectedReferences.length
      ? selectedReferences
          .map((selection) =>
            `- Reference ${selection.item.id} (${CREATIVE_CATEGORY_LABELS[selection.item.angle]}): ${selection.selectionReason}`
          )
          .join('\n')
      : '';
    const modeDirection = source
      ? generationSourceAsset?.role === 'TRA_REFERENCE'
        ? 'TRA ad mode: the validated uploaded TRA reference may be attached to final generation. Any selected library references are optional analysis-only design guidance for planning. They do not dictate a creative category, do not need to be used by every output, and their raw pixels are never attached to final generation.'
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

    const generationContext = `${parsed.data.context}\n\n${modeDirection}\n\n${humanSourceDirection}${brandDirection ? `\n\nTRA brand system:\n${brandDirection}` : ''}${analysisDirection ? `\n\n${analysisDirection}` : ''}${referenceDirections ? `\n\nOptional analysis-only reference guidance for the batch:\n${referenceDirections}\nUse a reference only when it supports the planned strategy. Do not copy it, treat its library category as required, or force one reference per output.` : ''}`;
    const batchPlan = await planCreativeBatch({
      count: parsed.data.variationCount,
      context: generationContext,
      analysis,
      hasApprovedHumanSource: hasUsableApprovedHumanSource,
    });
    const creativePlan = batchPlan.creatives;
    const diversityIssue = getCreativeDiversityIssue(creativePlan);
    if (diversityIssue) {
      return NextResponse.json(
        {
          error: `Creative planner returned an insufficiently diverse batch: ${diversityIssue}`,
        },
        { status: 502 }
      );
    }

    const analysisSources: CreativeGenerationProvenance['analysisSources'] = [
      ...(layoutBlueprint && generationSourceAsset
        ? [
            {
              type: 'LAYOUT_REFERENCE' as const,
              mediaId: generationSourceAsset.media.id,
              sha256: layoutBlueprint.contentHash,
              layoutCache: {
                sourceSha256: layoutBlueprint.contentHash,
                analyzerModel: layoutBlueprint.analyzerModel,
                schemaVersion: LAYOUT_BLUEPRINT_SCHEMA_VERSION,
              },
            },
          ]
        : []),
      ...selectedReferences.map((selection) => ({
        type: 'REFERENCE_LIBRARY' as const,
        mediaId: selection.item.id,
      })),
    ];

    const renderCreative = async (
      item: PlannedCreativeConcept
    ): Promise<GeneratedCreative> => {
          const creativeId = `creative_${randomUUID().replaceAll('-', '')}`;
          const identity = buildCreativeIdentity({
            creativeId,
            operation: 'GENERATE',
            strategy: item.strategy,
          });
          const copy = item.copy;
          const selectedReference = selectedReferences[item.index - 1];
          const singleReferenceContract = selectedReference
            ? `\n\nOPTIONAL ANALYSIS-ONLY REFERENCE GUIDANCE:\n- External reference: ${selectedReference.item.id}.\n- Its raw pixels are NOT attached to final generation.\n- Use it only when compatible with the planned strategy and visual direction; its library category is not a requirement.\n- Do not recreate unseen details, copy third-party identity or unsupported claims, or combine competing visual systems.\n- Selection reason: ${selectedReference.selectionReason}`
            : '';
          const itemHumanDirection =
            item.strategy.execution.subjectSource === 'non-human'
              ? 'This planned concept is explicitly non-human. Do not depict any person, face, spokesperson, body, or human figure even though approved TRA source pixels may be attached.'
              : humanSourceDirection;
          const execution = item.strategy.execution;
          const itemContext = `${parsed.data.context}${videoFrameSet ? `\n\n${modeDirection}` : ''}\n\n${itemHumanDirection}${brandDirection ? `\n\nTRA brand system:\n${brandDirection}` : ''}${analysisDirection ? `\n\n${analysisDirection}` : ''}\n\nPLANNED CREATIVE BRIEF:\nSelection reason: ${item.selectionReason}\nPrimary category: ${CREATIVE_CATEGORY_LABELS[item.strategy.category]}\nSO WHAT outcome chain:\n- Surface message: ${item.strategy.soWhat.surfaceMessage}\n- Functional consequence: ${item.strategy.soWhat.functionalConsequence}\n- Meaningful customer outcome: ${item.strategy.soWhat.meaningfulOutcome}\nExecution:\n- Subject source: ${execution.subjectSource}\n- Composition: ${execution.composition}\n- Image treatment: ${execution.imageTreatment}\n- Text density: ${execution.textDensity}\n- CTA treatment: ${execution.ctaTreatment}\n- Typography hierarchy: ${execution.typographyHierarchy}\nVisual direction: ${item.strategy.visualDirection}${singleReferenceContract}`;
          let imageResult: ImageGenerationResult;
          let providerFrames: ApprovedTraVideoFrame[] | undefined;

          if (providerImageSource) {
            imageResult = await generateApprovedTraReferenceCreativeImage({
              source: providerImageSource.stored,
              primaryFormat: item.format,
              placement: parsed.data.placement,
              context: itemContext,
              copy,
              reserveLogoArea,
            });
          } else if (videoFrameSet) {
            const videoImageResult = await generateApprovedTraVideoFrameCreativeImage({
              frames: videoFrameSet.frames,
              primaryFormat: item.format,
              placement: parsed.data.placement,
              context: itemContext,
              copy,
              reserveLogoArea,
            });
            imageResult = videoImageResult;
            providerFrames = videoImageResult.providerFrames;
          } else {
            imageResult = await generatePromptOnlyCreativeImage({
              primaryFormat: item.format,
              placement: parsed.data.placement,
              context: itemContext,
              copy,
              reserveLogoArea,
            });
          }

          await validateGeneratedCreativeImage(imageResult.buffer, parsed.data.placement);
          const finalImage = brandLogo
            ? await compositeCreativeBrandLogo(imageResult.buffer, brandLogo.buffer, parsed.data.placement)
            : imageResult.buffer;
          const generatedFile = new File(
            [new Uint8Array(finalImage)],
            `tra-creative-${item.index}.png`,
            { type: 'image/png' }
          );
          const image = await storage.saveImage(generatedFile);
          const uploadedReferenceImageId =
            generationSourceAsset?.role === 'LAYOUT_REFERENCE'
              ? generationSourceAsset.media.id
              : undefined;
          const attachedSource: CreativeGenerationProvenance['attachedSource'] =
            providerImageSource
              ? {
                  type: 'TRA_REFERENCE_IMAGE',
                  mediaId: providerImageSource.media.id,
                  sha256: sha256(providerImageSource.stored.buffer),
                }
              : providerFrames
                ? {
                    type: 'TRA_VIDEO_FRAMES',
                    mediaId: providerFrames[0].sourceVideoMediaId,
                    sourceSha256: providerFrames[0].sourceVideoContentHash,
                    selectionMode: generatedVideoFrameSelection
                      ? 'USER_SELECTED'
                      : 'AUTOMATIC',
                    frames: providerFrames.map((frame) => ({
                      timestampMs: frame.timestampMs,
                      approvedPngSha256: frame.frameSha256,
                    })),
                  }
                : null;
          const generationProvenance: CreativeGenerationProvenance = {
            version: 1,
            imageGeneration: {
              prompt: imageResult.prompt,
              model: imageResult.model,
            },
            requestedSources,
            attachedSource,
            analysisSources,
            ...(logoOverlaySource ? { logoOverlaySource } : {}),
          };

          const creative: GeneratedCreative = {
            id: creativeId,
            index: item.index,
            category: item.strategy.category,
            format: item.format,
            placement: parsed.data.placement,
            image,
            copy,
            generationProvenance,
            identity,
            planning: {
              strategy: item.strategy,
              selectionReason: item.selectionReason,
              model: batchPlan.plannerModel,
              reasoningEffort: batchPlan.reasoningEffort,
            },
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
          const [saved] = await saveCreativeBatch([{ ...creative, createdAt: new Date().toISOString() }]);
          return { ...creative, finalization: { status: 'SAVED', createdAt: saved.createdAt } };
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
                error: error instanceof GeneratedImageValidationError
                  ? error.message
                  : `Creative ${item.index} could not be completed.`,
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
