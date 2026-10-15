import type { CreativeReferenceAnalysis } from '@/lib/ai/openai';
import type { PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';
import type { ValidGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import type { CreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';

export type SelectedVideoInputContract = { peoplePercent?: number; useReferenceLibrary?: boolean; requireSelectedVideoFrames?: boolean; requiredLayoutReferenceIds?: string[] };
export class SelectedVideoInputError extends Error {}

/** Explicit inputs outrank optional catalog inspiration; automatic video mode remains available. */
export function selectedVideoInputContract(request: Pick<ValidGenerateCreativeRequest, 'sourceAssets' | 'videoFrameSelection' | 'reviewHandoff' | 'peoplePercent' | 'useReferenceLibrary'>): SelectedVideoInputContract {
  const controls = { ...(request.peoplePercent === undefined ? {} : { peoplePercent: request.peoplePercent }),
    ...(request.useReferenceLibrary === undefined ? {} : { useReferenceLibrary: request.useReferenceLibrary }) };
  if (!request.sourceAssets?.some(source => source.role === 'TRA_VIDEO')) return controls;
  const layoutIds = request.sourceAssets.filter(source => source.role === 'LAYOUT_REFERENCE').map(source => source.mediaId);
  return {
    ...controls,
    ...(request.videoFrameSelection || request.reviewHandoff?.choices.frames?.length ? { requireSelectedVideoFrames: true } : {}),
    ...(layoutIds.length ? { requiredLayoutReferenceIds: layoutIds } : {}),
  };
}

export function inheritedVideoInputContract(provenance?: CreativeGenerationProvenance, retainedLayoutReferenceIds?: readonly string[]): SelectedVideoInputContract {
  const hasVideo = provenance?.requestedSources?.some(source => source.role === 'TRA_VIDEO');
  const layoutIds = provenance?.requestedSources?.filter(source => source.role === 'LAYOUT_REFERENCE').map(source => source.mediaId) ?? [];
  // An explicit saved binding distinguishes video-only removal from ordinary optional layouts.
  const requiredIds = hasVideo ? layoutIds : layoutIds.filter(id => retainedLayoutReferenceIds?.includes(id));
  if (!hasVideo && !requiredIds.length) return {};
  return {
    ...(hasVideo && provenance?.attachedSource?.type === 'TRA_VIDEO_FRAMES' && provenance.attachedSource.selectionMode === 'USER_SELECTED'
      ? { requireSelectedVideoFrames: true } : {}),
    ...(requiredIds.length ? { requiredLayoutReferenceIds: requiredIds } : {}),
  };
}

export function representativeVideoGuidance(source: CreativeGenerationProvenance['requestedSources'][number], analysis: CreativeReferenceAnalysis) {
  return { source, hasHuman: analysis.visibleHuman ?? null, analysis: {
    ...analysis, summary: `Primary TRA video ${source.mediaId}: ${analysis.summary}`,
  } };
}

export function assertSelectedVideoInputContract(concept: Pick<PlannedCreativeConcept, 'strategy'>, contract: SelectedVideoInputContract,
  preservedHuman?: Pick<PlannedCreativeConcept['strategy'], 'humanSourceId' | 'approvedHumanId'>) {
  if (contract.requireSelectedVideoFrames && (contract.peoplePercent === undefined || concept.strategy.execution.subjectSource === 'approved-tra-human') && (concept.strategy.execution.subjectSource !== 'approved-tra-human'
    || concept.strategy.humanSourceId !== preservedHuman?.humanSourceId || concept.strategy.approvedHumanId !== preservedHuman?.approvedHumanId)) {
    throw new SelectedVideoInputError('The plan ignored the explicitly selected TRA video frames. No images were generated. Use those frames or remove the selection explicitly.');
  }
  if (contract.requiredLayoutReferenceIds?.length && !contract.requiredLayoutReferenceIds.includes(concept.strategy.referenceSelection?.layoutSource ?? '')) {
    throw new SelectedVideoInputError('The plan ignored the supplied video layout reference. No images were generated. Use its composition or remove the reference explicitly.');
  }
}

/** Completed video observations are primary creative input, never proof of claims. */
export function primaryVideoGuidance(state?: PlanningSourceAnalysisState, mediaId?: string) {
  const entry = state?.entries.find(item => item.source.role === 'TRA_VIDEO'
    && (!mediaId || item.source.mediaId === mediaId));
  if (!entry) {
    if (state && mediaId) throw new Error('The selected video is absent from its saved analysis. Prepare it again.');
    return null;
  }
  const result = entry.result;
  if (!result || !['VIDEO_INTELLIGENCE', 'REPRESENTATIVE_VIDEO_FRAMES'].includes(result.kind)) {
    throw new Error('The selected video analysis is unavailable. Prepare the video again before generating.');
  }
  if (result.kind === 'REPRESENTATIVE_VIDEO_FRAMES') {
    return representativeVideoGuidance(entry.source, result.analysis);
  }
  if (result.kind !== 'VIDEO_INTELLIGENCE') throw new Error('Invalid primary video analysis.');
  const video = result.intelligence;
  if (!video.observations.length) throw new Error('The selected video has no visual observations. Prepare it again.');
  const segments = 'windows' in video.transcript
    ? video.transcript.windows.flatMap(window => window.segments) : video.transcript.excerpts;
  const observations = video.observations.map(frame => `${frame.timestampMs}ms: ${frame.observation.summary}`);
  const transcript = segments.map(segment => `${segment.startMs}-${segment.endMs}ms: ${segment.text}`);
  const bound = (values: string[]) => values.join('\n').slice(0, 2000);
  const hasHuman = video.observations.some(frame => frame.observation.sceneType === 'PERSON');
  const analysis: CreativeReferenceAnalysis = {
    summary: `Primary TRA video ${entry.source.mediaId}:\n${bound(observations)}`,
    visibleText: video.observations.flatMap(frame => frame.observation.visibleText).slice(0, 10).map(text => text.slice(0, 256)),
    visualStructure: bound(video.observations.map(frame => `${frame.timestampMs}ms: ${frame.observation.composition}`)),
    hookOrAngle: bound(transcript.length ? transcript : observations),
    offerOrCta: 'Use exact video statements as traceable source assertions in drafts; verified facts and publishing permission require their separate approval path.',
    styleNotes: 'The selected video supplies the subject and creative direction; company knowledge supports brand and verified facts.',
    preserve: ['Selected video content and source identity', ...(hasHuman ? ['The visible TRA human, using verified source frames'] : [])],
    avoid: ['Unrelated knowledge-base-only concepts', 'Invented people or unsupported source claims'],
    unknowns: video.observations.flatMap(frame => frame.observation.uncertainties).slice(0, 10).map(text => text.slice(0, 256)),
    dominantCategory: 'customer-problems',
  };
  return { source: entry.source, hasHuman, analysis };
}

export const primaryVideoDirection = (guidance: NonNullable<ReturnType<typeof primaryVideoGuidance>>, peoplePercent?: number) =>
  `PRIMARY SELECTED VIDEO ${guidance.source.mediaId} (source SHA-256 ${guidance.source.sha256}).
Use this video as the primary creative evidence. Company knowledge supports brand and verified facts; it must not replace the selected video with unrelated concepts. These bounded observations/transcript excerpts are partial source content, not approved claims or complete narratives. Preserve the supplied human through assessed fresh frames when using a person; no catalog-person substitution. ${guidance.hasHuman && peoplePercent === undefined ? 'Include at least one concept using that visible TRA human (subjectSource approved-tra-human, no catalog humanSourceId). If usable human frames cannot be verified, stop visibly rather than substitute unrelated graphics.' : ''}
Read the primary video content in referenceAnalysis and sourceAnalysis. Exact statements may inform current drafts through draftVideoSourceSelection without a manual Proof Library prerequisite. Their claims remain source assertions, not independent verification or publishing permission.`;

/** The image renderer gets visual grounding, not unplanned transcript/claims/caption copy. */
export const primaryVideoRenderDirection = (guidance: NonNullable<ReturnType<typeof primaryVideoGuidance>>, peoplePercent?: number) =>
  `PRIMARY SELECTED VIDEO ${guidance.source.mediaId} (source SHA-256 ${guidance.source.sha256}).
The selected video is the primary visual source. Use the planned concept and exactCopy; company knowledge supplies supporting brand/facts. ${peoplePercent === undefined ? 'Preserve the attached assessed TRA identity.' : 'When this concept calls for a person, preserve the attached assessed TRA identity. Non-human concepts must depict no person and receive no human source pixels.'} Do not redraw source captions, logos or unplanned text/claims. These partial visual observations are guidance, not advertising evidence:
${JSON.stringify({ summary: guidance.analysis.summary, composition: guidance.analysis.visualStructure })}`;
