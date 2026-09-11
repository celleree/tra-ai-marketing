import { assertGenerationAvailable, hydrateGenerationSources, CreativeGenerationPreparationError } from '@/lib/creatives/generation-sources';
export { generatePromptOnlyCreativeImage } from '@/lib/ai/prompt-only-generation';
import { renderPlannedCreative } from '@/lib/creatives/render-planned';
import { buildReferencePlanningCatalog } from '@/lib/references/planning.server';
import { loadApprovedHumanOptions } from '@/lib/video/approved-human-planning';
import { NextResponse } from 'next/server';
import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { requireOperatorQuota } from '@/lib/quotas/require-quota';
import {
  analyzeTraSourceCreative,
  analyzeReferenceCreative,
  type CreativeReferenceAnalysis,
} from '@/lib/ai/openai';
import { planCreativeBatch } from '@/lib/ai/creative-planner';
import {
  analyzeApprovedTraVideoFrames,
} from '@/lib/ai/video-frame-generation';
import {
  selectBestReferenceCreatives,
  type ReferenceSelectionCandidate,
  type SelectedReferenceCreative,
} from '@/lib/ai/reference-selector';
import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import {
  validateGenerateCreativeRequest,
} from '@/lib/creatives/generate-request';
import type { CreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import { GeneratedImageValidationError } from '@/lib/creatives/generated-image-validation';
import { getCreativeDiversityIssue } from '@/lib/creatives/diversity';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import {
  formatLayoutBlueprintForPlanning,
  LAYOUT_BLUEPRINT_SCHEMA_VERSION,
  type LayoutBlueprint,
} from '@/lib/layouts/blueprint';
import {
  getOrAnalyzeLayoutBlueprint,
  type ResolvedLayoutBlueprint,
} from '@/lib/layouts/service';
import { CreativeSourceHydrationError } from '@/lib/media/source-hydration';
import { isUsableApprovedHumanSource } from '@/lib/media/types';
import { listReferenceLibrary } from '@/lib/references/storage';
import type { ReferenceLibraryItem } from '@/lib/references/types';
import { TraVideoProcessingError } from '@/lib/video/ffmpeg';

export const runtime = 'nodejs';
export const maxDuration = 300;

const RENDER_CONCURRENCY = 2;

const encodeSseEvent = (
  encoder: TextEncoder,
  event: 'creative' | 'error' | 'complete',
  payload: object
) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);

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
    'External layout reference reduced to a validated design-only LayoutBlueprint. Its separately analyzed angle is optional planning inspiration, never approved copy, claims, brand identity, trademark identity or person identity.',
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

const buildReferenceCandidates = (
  library: ReferenceLibraryItem[],
  requestUrl: string
): ReferenceSelectionCandidate[] =>
  library.map((item) => ({
    item,
    imageUrl: new URL(item.url, requestUrl).toString(),
  }));

export async function POST(request: Request) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);

  try {
    const body = await request.json();
    const parsed = validateGenerateCreativeRequest(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    assertGenerationAvailable(parsed.data);

    const quotaDenied = await requireOperatorQuota(
      access.userId,
      'CREATIVE_GENERATION',
      parsed.data.variationCount,
    );
    if (quotaDenied) return quotaDenied;

    const { storage, generationSourceAsset, requestedSources, source, providerImageSource, videoFrameSet,
      generatedVideoFrameSelection, brandLogo, reserveLogoArea, logoOverlaySource } = await hydrateGenerationSources(parsed.data);

    let analysis: CreativeReferenceAnalysis;
    let layoutBlueprint: ResolvedLayoutBlueprint | null = null;
    let selectedReferences: SelectedReferenceCreative[] = [];

    if (source && generationSourceAsset?.role === 'LAYOUT_REFERENCE') {
      layoutBlueprint = await getOrAnalyzeLayoutBlueprint(source);
      analysis = buildLayoutReferenceAnalysis(layoutBlueprint.blueprint);
      // Strategy analysis is planner-only; the renderer still receives controlled geometry.
      analysis.hookOrAngle = (await analyzeReferenceCreative(source, parsed.data.context)).hookOrAngle;
    } else if (source && generationSourceAsset?.role === 'TRA_REFERENCE') {
      analysis = await analyzeTraSourceCreative(source, parsed.data.context);

    } else if (videoFrameSet) {
      analysis = await analyzeApprovedTraVideoFrames({
        frames: videoFrameSet.frames,
        context: parsed.data.context,
      });
    } else {
      analysis = buildPromptOnlyAnalysis(parsed.data.context);
    }

    const library = (await listReferenceLibrary()).filter(item => item.referenceType === 'layout');
    const requestedReferenceCount = Math.min(8, parsed.data.variationCount, library.length);
    if (requestedReferenceCount > 0) selectedReferences = await selectBestReferenceCreatives({
      candidates: buildReferenceCandidates(library, request.url), requestedCount: requestedReferenceCount,
      userContext: parsed.data.context, traSummary: analysis.summary, traPreserve: analysis.preserve,
    });
    const referenceCatalog = await buildReferencePlanningCatalog({ storage, selections: selectedReferences,
      ...(source && generationSourceAsset ? { uploaded: { referenceId: generationSourceAsset.media.id, source,
        angleDescription: analysis.hookOrAngle, ...(layoutBlueprint ? { layout: layoutBlueprint } : {}) } } : {}),
    });
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
        : 'Layout-reference mode: consider the uploaded reference angle and cached blueprint independently as priority options in the catalog. Either choice may be original. Its raw pixels and any person identity in it must never reach final image generation.'
      : videoFrameSet
        ? `Video-source mode: the raw TRA video ${videoFrameSet.source.media.id} remains server-side and is never attached to the image provider. A bounded set of server-extracted approved still frames is available as TRA human/content source pixels. Do not treat old video framing, captions, or graphics as a required static-ad layout.`
        : 'No-image mode: create TRA ads from the user direction, using catalog references only when they support the proposition.';

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
    const approvedHumanOptions = await loadApprovedHumanOptions();
    const humanSourceDirection = approvedHumanOptions.length
      ? 'Curated approvedHumanOptions are available as independent human sources. Choose a stable ID only when that person strengthens the proposition; selecting one replaces any supplied human source for that concept. Choose null for a graphic concept or an explicitly supplied approved source. No invented people or identity-based claims.'
      : videoFrameSet
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
      referenceCatalog,
      ...(approvedHumanOptions.length ? { approvedHumanOptions } : {}),
    });
    const creativePlan = batchPlan.creatives;
    const diversityIssue = getCreativeDiversityIssue(creativePlan, batchPlan.portfolioAudit);
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

    const renderContext = {
      request: parsed.data, batchPlan, referenceCatalog, selectedReferences, requestedSources, analysisSources,
      logoOverlaySource, reserveLogoArea, brandLogo, providerImageSource, videoFrameSet, generatedVideoFrameSelection, storage,
    };
    const renderCreative = (item: PlannedCreativeConcept) => renderPlannedCreative(item, renderContext);

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
    if (error instanceof CreativeGenerationPreparationError || error instanceof CreativeSourceHydrationError || error instanceof TraVideoProcessingError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Creative generation failed', error);
    return NextResponse.json(
      { error: 'Creative generation failed. Check the server configuration and try again.' },
      { status: 500 }
    );
  }
}
