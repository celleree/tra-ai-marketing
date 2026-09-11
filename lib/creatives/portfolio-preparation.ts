import { analyzeReferenceCreative, analyzeTraSourceCreative, type CreativeReferenceAnalysis } from '@/lib/ai/openai';
import { requestCreativeBatch } from '@/lib/ai/creative-planner';
import { analyzeApprovedTraVideoFrames } from '@/lib/ai/video-frame-generation';
import { selectBestReferenceCreatives, type ReferenceSelectionCandidate, type SelectedReferenceCreative } from '@/lib/ai/reference-selector';
import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import type { ValidGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import type { CreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import { hydrateGenerationSources } from '@/lib/creatives/generation-sources';
import type { PreparedCreativeGeneration } from '@/lib/creatives/prepare-generation';
import { formatLayoutBlueprintForPlanning, LAYOUT_BLUEPRINT_SCHEMA_VERSION, type LayoutBlueprint } from '@/lib/layouts/blueprint';
import { getOrAnalyzeLayoutBlueprint, type ResolvedLayoutBlueprint } from '@/lib/layouts/service';
import { isUsableApprovedHumanSource } from '@/lib/media/types';
import { loadApprovedHumanOptions } from '@/lib/video/approved-human-planning';
import { listReferenceLibrary } from '@/lib/references/storage';
import type { ReferenceLibraryItem } from '@/lib/references/types';
import type { ReferencePlanningCandidate } from '@/lib/references/planning';

export type PortfolioPreparationState = {
  quotaReserved: boolean;
  analysis?: CreativeReferenceAnalysis;
  sourceLayout?: ResolvedLayoutBlueprint;
  selectedReferences?: SelectedReferenceCreative[];
  referenceCatalog?: ReferencePlanningCandidate[];
};

export type PortfolioPreparationResult =
  | { state: PortfolioPreparationState; prepared?: never }
  | { prepared: PreparedCreativeGeneration; state?: never };

const buildPromptOnlyAnalysis = (context: string): CreativeReferenceAnalysis => ({
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

const buildLayoutReferenceAnalysis = (blueprint: LayoutBlueprint): CreativeReferenceAnalysis => ({
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

const buildReferenceCandidates = (library: ReferenceLibraryItem[], requestUrl: string): ReferenceSelectionCandidate[] =>
  library.map((item) => ({ item, imageUrl: new URL(item.url, requestUrl).toString() }));

const toCatalogItem = (
  referenceId: string,
  priority: 'user' | 'library',
  angleDescription: string,
  layout: ResolvedLayoutBlueprint,
): ReferencePlanningCandidate => ({
  referenceId,
  priority,
  angleDescription: angleDescription.slice(0, 2000),
  sourceSha256: layout.contentHash,
  analyzerModel: layout.analyzerModel,
  blueprint: layout.blueprint,
});

/**
 * Advance pre-plan work by at most one provider-capable operation.
 * Every call that invokes source analysis, reference selection, layout analysis, or Astra returns immediately afterward,
 * allowing the caller to durably checkpoint before any later paid/provider work begins.
 */
export async function advancePortfolioPreparation(
  data: ValidGenerateCreativeRequest,
  requestUrl: string,
  current: PortfolioPreparationState,
  onProviderOperationStart: () => void,
): Promise<PortfolioPreparationResult> {
  const state = structuredClone(current);
  const {
    storage,
    generationSourceAsset,
    requestedSources,
    source,
    providerImageSource,
    videoFrameSet,
    generatedVideoFrameSelection,
    brandLogo,
    reserveLogoArea,
    logoOverlaySource,
  } = await hydrateGenerationSources(data);

  if (source && generationSourceAsset?.role === 'LAYOUT_REFERENCE' && !state.sourceLayout) {
    onProviderOperationStart();
    state.sourceLayout = await getOrAnalyzeLayoutBlueprint(source);
    return { state };
  }

  if (!state.analysis) {
    if (source && generationSourceAsset?.role === 'LAYOUT_REFERENCE') {
      const analysis = buildLayoutReferenceAnalysis(state.sourceLayout!.blueprint);
      onProviderOperationStart();
      analysis.hookOrAngle = (await analyzeReferenceCreative(source, data.context)).hookOrAngle;
      state.analysis = analysis;
      return { state };
    }
    if (source && generationSourceAsset?.role === 'TRA_REFERENCE') {
      onProviderOperationStart();
      state.analysis = await analyzeTraSourceCreative(source, data.context);
      return { state };
    }
    if (videoFrameSet) {
      onProviderOperationStart();
      state.analysis = await analyzeApprovedTraVideoFrames({ frames: videoFrameSet.frames, context: data.context });
      return { state };
    }
    state.analysis = buildPromptOnlyAnalysis(data.context);
  }

  if (source && generationSourceAsset?.role === 'TRA_REFERENCE' && !state.sourceLayout) {
    onProviderOperationStart();
    state.sourceLayout = await getOrAnalyzeLayoutBlueprint(source);
    return { state };
  }

  if (!state.selectedReferences) {
    const library = (await listReferenceLibrary()).filter(item => item.referenceType === 'layout');
    const requestedReferenceCount = Math.min(8, data.variationCount, library.length);
    if (requestedReferenceCount > 0) {
      onProviderOperationStart();
      state.selectedReferences = await selectBestReferenceCreatives({
        candidates: buildReferenceCandidates(library, requestUrl),
        requestedCount: requestedReferenceCount,
        userContext: data.context,
        traSummary: state.analysis.summary,
        traPreserve: state.analysis.preserve,
      });
      return { state };
    }
    state.selectedReferences = [];
  }

  if (!state.referenceCatalog) {
    state.referenceCatalog = source && generationSourceAsset && state.sourceLayout
      ? [toCatalogItem(generationSourceAsset.media.id, 'user', state.analysis.hookOrAngle, state.sourceLayout)]
      : [];
  }

  const pendingReference = state.selectedReferences.find(
    selection => !state.referenceCatalog!.some(item => item.referenceId === selection.item.id),
  );
  if (pendingReference) {
    const stored = await storage.readImageById(pendingReference.item.id);
    if (!stored) throw new Error(`Reference ${pendingReference.item.id} is unavailable.`);
    onProviderOperationStart();
    const layout = await getOrAnalyzeLayoutBlueprint(stored);
    state.referenceCatalog.push(toCatalogItem(
      pendingReference.item.id,
      'library',
      `${CREATIVE_CATEGORY_LABELS[pendingReference.item.angle]}: ${pendingReference.selectionReason}`,
      layout,
    ));
    return { state };
  }

  const referenceDirections = state.selectedReferences.length
    ? state.selectedReferences
        .map(selection => `- Reference ${selection.item.id} (${CREATIVE_CATEGORY_LABELS[selection.item.angle]}): ${selection.selectionReason}`)
        .join('\n')
    : '';
  const modeDirection = source
    ? generationSourceAsset?.role === 'TRA_REFERENCE'
      ? 'TRA ad mode: the validated uploaded TRA reference may be attached to final generation. Any selected library references are optional analysis-only design guidance for planning. They do not dictate a creative category, do not need to be used by every output, and their raw pixels are never attached to final generation.'
      : 'Layout-reference mode: consider the uploaded reference angle and cached blueprint independently as priority options in the catalog. Either choice may be original. Its raw pixels and any person identity in it must never reach final image generation.'
    : videoFrameSet
      ? `Video-source mode: the raw TRA video ${videoFrameSet.source.media.id} remains server-side and is never attached to the image provider. A bounded set of server-extracted approved still frames is available as TRA human/content source pixels. Do not treat old video framing, captions, or graphics as a required static-ad layout.`
      : 'No-image mode: create TRA ads from the user direction, using catalog references only when they support the proposition.';

  const approvedHumanSource = providerImageSource || videoFrameSet?.source || null;
  const sourceSuppliedToImageGeneration = Boolean(providerImageSource || videoFrameSet?.frames.length);
  const hasUsableApprovedHumanSource = approvedHumanSource
    ? isUsableApprovedHumanSource(approvedHumanSource, sourceSuppliedToImageGeneration)
    : false;
  const approvedHumanOptions = await loadApprovedHumanOptions();
  const humanSourceDirection = approvedHumanOptions.length
    ? 'Curated approvedHumanOptions are available as independent human sources. Choose a stable ID only when that person strengthens the proposition; selecting one replaces any supplied human source for that concept. Choose null for a graphic concept or an explicitly supplied approved source. No invented people or identity-based claims.'
    : videoFrameSet
      ? `Use only a person visibly grounded in the attached approved TRA video frames from source ${videoFrameSet.source.media.id}. Preserve that visible identity; do not invent, replace, blend, or add another person. Layout-reference and library-reference people remain forbidden human sources.`
      : hasUsableApprovedHumanSource
        ? 'Use only the attached approved TRA human identity when depicting a person.'
        : 'Current generation boundary: no approved TRA human source is attached to final image generation. Do not depict any person, face, spokesperson, body, or human figure; use a non-human visual concept. Layout-reference and library-reference people are never approved human sources.';
  const colorDirection = data.brandColors?.length
    ? `Approved TRA brand palette from the uploaded logo: ${data.brandColors.join(', ')}. Use these as the primary design colors. Neutral black, white, and gray may be used for legibility, but do not substitute an unrelated dominant palette.`
    : '';
  const fontDirection = data.brandFontNames?.length
    ? `Approved typography guidance derived from actual uploaded TRA font files:\n${data.brandFontNames.map(font => `- ${font}`).join('\n')}\nUse these descriptions to match the approved typography character as closely as the image model allows. Do not introduce a conflicting type style just because it appears in a third-party reference image.`
    : '';
  const brandDirection = [colorDirection, fontDirection].filter(Boolean).join('\n\n');
  const analysisDirection = source
    ? 'Use referenceAnalysis as analysis-only source guidance (raw layout/library pixels are not attached unless the source is the validated TRA reference explicitly allowed at the final provider boundary).'
    : videoFrameSet
      ? 'referenceAnalysis describes the approved TRA video-frame source; preserve approved TRA cues and obey its avoid guidance.'
      : '';
  const generationContext = `${data.context}\n\n${modeDirection}\n\n${humanSourceDirection}${brandDirection ? `\n\nTRA brand system:\n${brandDirection}` : ''}${analysisDirection ? `\n\n${analysisDirection}` : ''}${referenceDirections ? `\n\nOptional analysis-only reference guidance for the batch:\n${referenceDirections}\nUse a reference only when it supports the planned strategy. Do not copy it, treat its library category as required, or force one reference per output.` : ''}`;
  const plannerArgs = {
    count: data.variationCount,
    context: generationContext,
    analysis: state.analysis,
    hasApprovedHumanSource: hasUsableApprovedHumanSource,
    referenceCatalog: state.referenceCatalog,
    ...(approvedHumanOptions.length ? { approvedHumanOptions } : {}),
  };

  onProviderOperationStart();
  const batchPlan = await requestCreativeBatch(plannerArgs);
  const analysisSources: CreativeGenerationProvenance['analysisSources'] = [
    ...(source && generationSourceAsset?.role === 'LAYOUT_REFERENCE' && state.sourceLayout
      ? [{
          type: 'LAYOUT_REFERENCE' as const,
          mediaId: generationSourceAsset.media.id,
          sha256: state.sourceLayout.contentHash,
          layoutCache: {
            sourceSha256: state.sourceLayout.contentHash,
            analyzerModel: state.sourceLayout.analyzerModel,
            schemaVersion: LAYOUT_BLUEPRINT_SCHEMA_VERSION,
          },
        }]
      : []),
    ...state.selectedReferences.map(selection => ({ type: 'REFERENCE_LIBRARY' as const, mediaId: selection.item.id })),
  ];

  return {
    prepared: {
      request: data,
      batchPlan,
      plannerArgs,
      referenceCatalog: state.referenceCatalog,
      selectedReferences: state.selectedReferences,
      requestedSources,
      analysisSources,
      logoOverlaySource,
      reserveLogoArea,
      brandLogo,
      providerImageSource,
      videoFrameSet,
      generatedVideoFrameSelection,
      storage,
    },
  };
}
