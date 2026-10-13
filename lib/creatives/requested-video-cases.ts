import type { VideoReviewHandoff } from '@/lib/creatives/review-handoff';
import { selectedCaseAssertion } from '@/lib/creatives/portfolio-case-amendment';

/** Inspect only user direction, never company policies or appended planner instructions. */
export function requestsVideoCases(context: string) {
  const direction = context.split('APPROVED TRA COMPANY CONTEXT')[0];
  return /\bcase[\s-]+stud(?:y|ies)\b|\btestimonials?\b|\bcases?\s+(?:described|shown|from|in)\b/i.test(direction)
    && !/\b(?:no|without|avoid|exclude)\s+(?:video\s+)?(?:case[\s-]+stud(?:y|ies)|testimonials?)\b/i.test(direction);
}

/** Explicit selected individual outcomes: exact text only, no new analysis or identity inference. */
export function requestedVideoCases(context: string, handoff?: VideoReviewHandoff) {
  if (!handoff || !requestsVideoCases(context)) return undefined;
  const cases = handoff.claimSnapshots.flatMap((claim, index) => {
    if (claim.reference.type !== 'VIDEO_TRANSCRIPT' || !/\b(i|my|me|mine)\b/i.test(claim.wording)
      || !/\$\s*\d|\d[\d,.]*\s*%|\b(saved|reduced|settled|resolved|eliminated)\b/i.test(claim.wording)) return [];
    return [selectedCaseAssertion(handoff, index)];
  });
  if (!cases.length) throw new Error('Select the complete video case statements before planning case-study ads. No source result will be guessed or replaced with generic copy.');
  return cases;
}
