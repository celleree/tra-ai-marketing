import type { CreativeAdCopy, CreativeImageCopy } from '@/lib/creatives/generated';
import type { PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';
import type { VideoReviewHandoff } from '@/lib/creatives/review-handoff';
import { SelectedVideoInputError } from '@/lib/creatives/primary-video-source';

type Segment = { segmentIndex: number; startMs: number; endMs: number; text: string };
export type DraftVideoSourcePassage = {
  passageId: string;
  sourceMediaId: string;
  sourceSha256: string;
  libraryId: string;
  kind: 'TRANSCRIPT' | 'ON_SCREEN';
  startMs: number;
  endMs: number;
  exactText: string;
  contextSegments: Segment[];
  uncertainties: string[];
  verification: 'UNVERIFIED_SOURCE_ASSERTION';
  permission: 'REQUIRES_REVIEW';
  contextCoverage: 'BOUNDED';
};
export type DraftVideoSourceAssertion = DraftVideoSourcePassage & { imageField: 'headline' | 'shortSupport' };
const MAX_PASSAGE_CHARS = 900;
const MAX_PASSAGES = 24;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;

/** Transport validation never converts a source assertion into approved Proof. */
export function parseDraftVideoSourceAssertion(value: unknown): DraftVideoSourceAssertion | null {
  if (!record(value) || Object.keys(value).length !== 14 || typeof value.passageId !== 'string'
    || !/^media_[a-f0-9]{32}$/.test(String(value.sourceMediaId)) || !/^[a-f0-9]{64}$/.test(String(value.sourceSha256))
    || !/^video-library:[a-f0-9]{64}$/.test(String(value.libraryId))
    || !['TRANSCRIPT', 'ON_SCREEN'].includes(String(value.kind)) || !time(value.startMs) || !time(value.endMs) || Number(value.endMs) < Number(value.startMs)
    || typeof value.exactText !== 'string' || !value.exactText.trim() || value.exactText.length > MAX_PASSAGE_CHARS
    || !Array.isArray(value.contextSegments) || value.contextSegments.length > 100
    || value.contextSegments.some(segment => !record(segment) || Object.keys(segment).length !== 4 || !time(segment.segmentIndex)
      || !time(segment.startMs) || !time(segment.endMs) || Number(segment.endMs) <= Number(segment.startMs) || typeof segment.text !== 'string')
    || !Array.isArray(value.uncertainties) || value.uncertainties.some(item => typeof item !== 'string')
    || value.verification !== 'UNVERIFIED_SOURCE_ASSERTION' || value.permission !== 'REQUIRES_REVIEW'
    || value.contextCoverage !== 'BOUNDED' || !['headline', 'shortSupport'].includes(String(value.imageField))) return null;
  if (value.kind === 'TRANSCRIPT' && (!value.contextSegments.length
    || value.exactText !== value.contextSegments.map(segment => segment.text).join(' ')
    || value.startMs !== value.contextSegments[0].startMs || value.endMs !== value.contextSegments.at(-1).endMs)) return null;
  return structuredClone(value) as unknown as DraftVideoSourceAssertion;
}

/** Reuses completed, source-bound observations. No new extraction/provider operation. */
export function projectDraftVideoSourcePassages(state?: PlanningSourceAnalysisState,
  guidance?: VideoReviewHandoff['operatorSelectedSourceGuidance'], primaryMediaId?: string): DraftVideoSourcePassage[] {
  const passages: DraftVideoSourcePassage[] = [];
  const add = (sourceMediaId: string, sourceSha256: string, libraryId: string, kind: DraftVideoSourcePassage['kind'],
    startMs: number, endMs: number, exactText: string, contextSegments: readonly Segment[], uncertainties: readonly string[] = []) => {
    if (!exactText.trim() || exactText.length > MAX_PASSAGE_CHARS || passages.length >= MAX_PASSAGES) return;
    if (passages.some(item => item.sourceMediaId === sourceMediaId && item.kind === kind && item.startMs === startMs && item.endMs === endMs && item.exactText === exactText)) return;
    const passageId = `${sourceMediaId}:${kind}:${startMs}:${endMs}:${passages.length}`;
    passages.push({ passageId, sourceMediaId, sourceSha256, libraryId, kind, startMs, endMs, exactText,
      contextSegments: structuredClone([...contextSegments]), uncertainties: [...uncertainties],
      verification: 'UNVERIFIED_SOURCE_ASSERTION', permission: 'REQUIRES_REVIEW', contextCoverage: 'BOUNDED' });
  };
  const transcript = (mediaId: string, hash: string, libraryId: string, segments: readonly Segment[]) => {
    // Keep a whole contiguous window when it fits. Otherwise retain immediate context on both sides;
    // never clip a sentence or silently remove a qualification from the selected passage.
    const runs: Segment[][] = [];
    for (const segment of segments) {
      if (!runs.length || segment.segmentIndex !== runs.at(-1)!.at(-1)!.segmentIndex + 1) runs.push([]);
      runs.at(-1)!.push(segment);
    }
    for (const run of runs) {
      const windows = run.map((_, index) => run.slice(Math.max(0, index - 1), index + 2));
      for (const selected of run.map(segment => segment.text).join(' ').length <= MAX_PASSAGE_CHARS ? [run] : windows) {
        add(mediaId, hash, libraryId, 'TRANSCRIPT', selected[0].startMs, selected.at(-1)!.endMs,
          selected.map(segment => segment.text).join(' '), selected);
      }
    }
  };
  // Explicitly reviewed passages have first consideration, including adjacent saved context.
  if (guidance?.video && (!primaryMediaId || guidance.video.locator.sourceVideoMediaId === primaryMediaId)) {
    const video = guidance.video;
    for (const statement of guidance.statements ?? []) if (statement.reference.type === 'VIDEO_TRANSCRIPT' && statement.context.type === 'VIDEO_TRANSCRIPT') {
      const first = statement.context.segments[0]?.segmentIndex, last = statement.context.segments.at(-1)?.segmentIndex;
      const context = guidance.transcriptContext?.segments.filter(segment => first !== undefined && last !== undefined
        && segment.segmentIndex >= first - 1 && segment.segmentIndex <= last + 1) ?? statement.context.segments;
      const text = context.map(segment => segment.text).join(' ');
      if (text.length > MAX_PASSAGE_CHARS) throw new SelectedVideoInputError('The selected video statement and its qualifications exceed the draft copy limit. Select a shorter complete source passage; no selected wording was truncated.');
      if (context.length) add(video.locator.sourceVideoMediaId, video.locator.sourceVideoContentHash, video.libraryId,
        'TRANSCRIPT', context[0].startMs, context.at(-1)!.endMs, text, context);
    }
    if (guidance.transcriptContext) transcript(video.locator.sourceVideoMediaId, video.locator.sourceVideoContentHash,
      video.libraryId, guidance.transcriptContext.segments);
    for (const statement of guidance.statements ?? []) if (statement.reference.type === 'VIDEO_ON_SCREEN' && statement.context.type === 'VIDEO_ON_SCREEN') {
      const text = statement.context.observation.visibleText.join(' ');
      if (text.length > MAX_PASSAGE_CHARS) throw new SelectedVideoInputError('The selected on-screen statement and its qualifications exceed the draft copy limit. Select a shorter complete source passage; no selected wording was truncated.');
      add(video.locator.sourceVideoMediaId, video.locator.sourceVideoContentHash, video.libraryId, 'ON_SCREEN',
        statement.reference.frame.timestampMs, statement.reference.frame.timestampMs, text, [], statement.context.observation.uncertainties);
    }
  }
  for (const entry of state?.entries ?? []) {
    if (entry.source.role !== 'TRA_VIDEO' || entry.result?.kind !== 'VIDEO_INTELLIGENCE' || (primaryMediaId && entry.source.mediaId !== primaryMediaId)) continue;
    const video = entry.result.intelligence;
    const windows = 'windows' in video.transcript ? video.transcript.windows.map(window => window.segments) : [video.transcript.excerpts];
    windows.forEach(segments => transcript(entry.source.mediaId, entry.source.sha256, video.library.id, segments));
    for (const frame of video.observations) {
      add(entry.source.mediaId, entry.source.sha256, video.library.id, 'ON_SCREEN', frame.timestampMs, frame.timestampMs,
        frame.observation.visibleText.join(' '), [], frame.observation.uncertainties);
    }
  }
  const hasSourceText = Boolean((!primaryMediaId || guidance?.video?.locator.sourceVideoMediaId === primaryMediaId)
    && (guidance?.transcriptContext?.segments.length || guidance?.statements?.some(statement => statement.reference.type === 'VIDEO_ON_SCREEN'))
    || state?.entries.some(entry => entry.source.role === 'TRA_VIDEO' && entry.result?.kind === 'VIDEO_INTELLIGENCE'
      && (!primaryMediaId || entry.source.mediaId === primaryMediaId)
      && (entry.result.intelligence.transcript.totalSegmentCount || entry.result.intelligence.observations.some(frame => frame.observation.visibleText.length))));
  if (hasSourceText && !passages.length) throw new SelectedVideoInputError('The video source statements exceed the draft copy limit. Select a shorter complete source passage with its qualifications; no images were generated.');
  return passages;
}

export function composeDraftVideoAssertion(selection: unknown, catalog: readonly DraftVideoSourcePassage[], adCopy: CreativeAdCopy, imageCopy: CreativeImageCopy, replacePrimaryText = false) {
  if (selection === null) return { adCopy, imageCopy };
  if (!record(selection) || Object.keys(selection).length !== 2 || !['headline', 'shortSupport'].includes(String(selection.imageField))) throw new SelectedVideoInputError('The plan returned an invalid video source passage selection. No images were generated.');
  const passage = catalog.find(item => item.passageId === selection.passageId);
  if (!passage) throw new SelectedVideoInputError('The selected video source passage is unavailable. No images were generated.');
  const assertion: DraftVideoSourceAssertion = { ...structuredClone(passage), imageField: selection.imageField as DraftVideoSourceAssertion['imageField'] };
  return { adCopy: { ...adCopy, primaryText: replacePrimaryText ? passage.exactText : `${adCopy.primaryText}\n\n${passage.exactText}` },
    imageCopy: { ...imageCopy, [assertion.imageField]: passage.exactText }, draftSourceAssertion: assertion };
}

export function assertDraftVideoAssertionCopy(assertion: DraftVideoSourceAssertion | undefined,
  copy: { adCopy?: CreativeAdCopy; imageCopy?: CreativeImageCopy }) {
  if (!assertion) return;
  if (!parseDraftVideoSourceAssertion(assertion) || copy.imageCopy?.[assertion.imageField] !== assertion.exactText
    || !copy.adCopy?.primaryText.split('\n\n').includes(assertion.exactText)) {
    throw new SelectedVideoInputError('The draft must retain its exact video source passage and qualifications. No images were generated.');
  }
}
