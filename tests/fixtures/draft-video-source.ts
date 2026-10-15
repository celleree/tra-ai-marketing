import { projectDraftVideoSourcePassages } from '@/lib/creatives/draft-video-assertion';
import type { VideoReviewHandoff } from '@/lib/creatives/review-handoff';
import { video } from './video-review-selection';

export const caseSegments = [
  { segmentIndex: 0, startMs: 1000, endMs: 3000, text: 'In this case, the client owed $82,000.' },
  { segmentIndex: 1, startMs: 3000, endMs: 5000, text: 'The settlement was $1,500.' },
  { segmentIndex: 2, startMs: 5000, endMs: 7000, text: 'Results depend on individual eligibility; this is not a guaranteed outcome.' },
];
export const draftVideoGuidance = { video, transcriptContext: { segments: caseSegments }, statements: null } as unknown as VideoReviewHandoff['operatorSelectedSourceGuidance'];
export const draftVideoPassage = () => projectDraftVideoSourcePassages(undefined, draftVideoGuidance)[0];
export const draftVideoAssertion = () => ({ ...draftVideoPassage(), imageField: 'shortSupport' as const });
