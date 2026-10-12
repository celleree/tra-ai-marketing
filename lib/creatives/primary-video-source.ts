import type { CreativeReferenceAnalysis } from '@/lib/ai/openai';
import type { PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';

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
    return { source: entry.source, hasHuman: false, analysis: {
      ...result.analysis, summary: `Primary TRA video ${entry.source.mediaId}: ${result.analysis.summary}`,
    } };
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
    offerOrCta: 'Use source messaging only when supported by approved TRA facts and evidence.',
    styleNotes: 'The selected video supplies the subject and creative direction; company knowledge supports brand and verified facts.',
    preserve: ['Selected video content and source identity', ...(hasHuman ? ['The visible TRA human, using verified source frames'] : [])],
    avoid: ['Unrelated knowledge-base-only concepts', 'Invented people or unsupported source claims'],
    unknowns: video.observations.flatMap(frame => frame.observation.uncertainties).slice(0, 10).map(text => text.slice(0, 256)),
    dominantCategory: 'customer-problems',
  };
  return { source: entry.source, hasHuman, analysis };
}

export const primaryVideoDirection = (guidance: NonNullable<ReturnType<typeof primaryVideoGuidance>>) =>
  `PRIMARY SELECTED VIDEO ${guidance.source.mediaId} (source SHA-256 ${guidance.source.sha256}).
Use this video as the primary creative evidence. Company knowledge supports brand and verified facts; it must not replace the selected video with unrelated concepts. These bounded observations/transcript excerpts are partial source content, not approved claims or complete narratives. Preserve the supplied human through assessed fresh frames when using a person; no catalog-person substitution. ${guidance.hasHuman ? 'Include at least one concept using that visible TRA human (subjectSource approved-tra-human, no catalog humanSourceId). If usable human frames cannot be verified, stop visibly rather than substitute unrelated graphics.' : ''}
${JSON.stringify(guidance.analysis)}`;

/** The image renderer gets visual grounding, not unplanned transcript/claims/caption copy. */
export const primaryVideoRenderDirection = (guidance: NonNullable<ReturnType<typeof primaryVideoGuidance>>) =>
  `PRIMARY SELECTED VIDEO ${guidance.source.mediaId} (source SHA-256 ${guidance.source.sha256}).
The selected video is the primary visual source. Use the planned concept and exactCopy; company knowledge supplies supporting brand/facts. Preserve the attached assessed TRA identity. Do not redraw source captions, logos or unplanned text/claims. These partial visual observations are guidance, not advertising evidence:
${JSON.stringify({ summary: guidance.analysis.summary, composition: guidance.analysis.visualStructure })}`;
