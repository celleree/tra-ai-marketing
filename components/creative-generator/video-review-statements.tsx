'use client';

import { useEffect, useState } from 'react';
import { readStoredRuntimeCompanyProfile } from '@/lib/company/creative-context';
import { KNOWLEDGE_BASE_FIELDS } from '@/lib/company/profile';
import type { discoverReviewStatements } from '@/lib/video/review-statement-discovery';
import type { ReviewClaimReference, ReviewClaimSnapshot } from '@/lib/video/review-selection';
import type { useVideoReviewDraft } from './use-video-review-draft';
import { reviewTime, type ReviewSource } from './video-review-panel';
import styles from './video-review-panel.module.css';

type StatementSource = Awaited<ReturnType<typeof discoverReviewStatements>>;
const key = (reference: ReviewClaimReference) => JSON.stringify(reference);
export const toggleReviewClaim = (claims: ReviewClaimReference[] | null, reference: ReviewClaimReference) =>
  claims?.some(item => key(item) === key(reference)) ? claims.filter(item => key(item) !== key(reference))
    : (claims?.length ?? 0) < 50 ? [...(claims ?? []), reference] : claims!;
export const videoReviewStatements = (review: NonNullable<ReviewSource['review']>): ReviewClaimSnapshot[] => [
  ...review.library.transcript.segments.filter(segment => segment.text.trim()).map(segment => ({
    reference: { type: 'VIDEO_TRANSCRIPT' as const, startSegmentIndex: segment.segmentIndex, endSegmentIndex: segment.segmentIndex },
    wording: segment.text, context: { type: 'VIDEO_TRANSCRIPT' as const, segments: [segment] } })), ...review.onScreenStatements,
];
const sourceLabel = (statement: ReviewClaimSnapshot) => {
  const context = statement.context;
  switch (context.type) {
    case 'VIDEO_TRANSCRIPT': return `Video transcript · ${reviewTime(context.segments[0].startMs)}–${reviewTime(context.segments.at(-1)!.endMs)}`;
    case 'VIDEO_ON_SCREEN': return `On-screen video text · ${reviewTime((statement.reference as Extract<ReviewClaimReference, { type: 'VIDEO_ON_SCREEN' }>).frame.timestampMs)} · Unverified observation`;
    case 'PROOF': return context.record.type === 'review' ? `Customer Review${context.record.source ? ` · ${context.record.source}` : ''}` : `Case Study · ${context.record.title}`;
    case 'COMPANY_PROFILE': return `Company Profile · ${KNOWLEDGE_BASE_FIELDS.find(field => field.key === (statement.reference as Extract<ReviewClaimReference, { type: 'COMPANY_PROFILE' }>).field)?.label ?? 'Saved context'}`;
  }
};
function StatementContext({ statement, review }: { statement: ReviewClaimSnapshot; review: NonNullable<ReviewSource['review']> }) {
  const context = statement.context;
  if (context.type === 'PROOF') return context.record.type === 'review' ? <p>{context.record.originalReviewText}</p>
    : <><p>{context.record.sourceNote}</p>{context.record.verifiedFacts.map((fact, index) => <p key={index}>{fact}</p>)}</>;
  if (context.type === 'COMPANY_PROFILE') return <><p>{context.fieldText}</p>{Object.entries(context.guardrails ?? {}).map(([field, text]) => <p key={field}>{text}</p>)}</>;
  if (context.type === 'VIDEO_ON_SCREEN') return <>{context.observation.uncertainties.map((text, index) => <p key={index}>{text}</p>)}</>;
  const first = context.segments[0].segmentIndex, last = context.segments.at(-1)!.segmentIndex;
  return <>{review.library.transcript.segments.filter(segment => segment.segmentIndex >= first - 1 && segment.segmentIndex <= last + 1)
    .map(segment => <p key={segment.segmentIndex}><time>{reviewTime(segment.startMs)}</time> {segment.text}</p>)}</>;
}

export function VideoReviewStatements({ review, draft, disabled }: { review: NonNullable<ReviewSource['review']>;
  draft: ReturnType<typeof useVideoReviewDraft>; disabled: boolean }) {
  const [sources, setSources] = useState<StatementSource | null>(null), [error, setError] = useState('');
  const profile = draft.state.choices?.companyProfile ?? readStoredRuntimeCompanyProfile() ?? null;
  useEffect(() => {
    const controller = new AbortController(); setSources(null); setError('');
    void (async () => {
      try {
        const response = await fetch('/api/video/review-sources', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companyProfile: profile }), cache: 'no-store', signal: controller.signal });
        const next = await response.json();
        if (!response.ok) throw new Error(next.error || 'Statement sources could not be loaded.');
        if (!controller.signal.aborted) setSources(next);
      } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
    })();
    return () => controller.abort();
  }, [JSON.stringify(profile)]);
  const matching = JSON.stringify(draft.state.choices?.video) === JSON.stringify(review.video);
  const claims = draft.state.choices?.claims?.filter(reference => matching || !reference.type.startsWith('VIDEO_')) ?? [];
  const available = [...videoReviewStatements(review), ...(sources?.statements ?? [])];
  const saved = draft.state.saved?.draft.claimSnapshots.filter(statement => matching || !statement.reference.type.startsWith('VIDEO_')) ?? [];
  // Retained excerpts and unavailable sources stay visible; discovery never rewrites saved wording.
  const statements = [...available, ...saved.filter(statement => !available.some(item => key(item.reference) === key(statement.reference)))];
  const choose = (statement: ReviewClaimSnapshot) => void draft.update(review.video, choices => ({ ...choices,
    claims: toggleReviewClaim(choices.claims, statement.reference),
    companyProfile: statement.reference.type === 'COMPANY_PROFILE' ? sources?.companyProfile ?? choices.companyProfile : choices.companyProfile }));
  return <div className={styles.statements}>
    <div className={styles.heading}><strong>Statements</strong><span>{claims.length} selected</span></div>
    {error ? <p role="alert">{error}</p> : null}
    {draft.state.choices?.companyProfile && JSON.stringify(draft.state.choices.companyProfile) !== JSON.stringify(readStoredRuntimeCompanyProfile() ?? null)
      ? <p className={styles.metadata}>Using saved Company Profile context.</p> : null}
    {statements.map(statement => { const checked = claims.some(reference => key(reference) === key(statement.reference));
      const proof = statement.context.type === 'PROOF' && statement.context.record.type === 'case-study' ? statement.context.record : null;
      return <div key={key(statement.reference)} className={styles.statement}>
        <label><input type="checkbox" checked={checked} disabled={disabled || (!checked && claims.length >= 50)} onChange={() => choose(statement)} />
          <span>{statement.wording}</span></label>
        <p className={styles.metadata}>{sourceLabel(statement)}</p>
        {proof?.requiredDisclaimer ? <p className={styles.metadata}>{proof.requiredDisclaimer}</p> : null}
        {proof?.usageRestrictions ? <p className={styles.metadata}>{proof.usageRestrictions}</p> : null}
        <details><summary>View context</summary><StatementContext statement={statement} review={review} /></details>
      </div>;
    })}
    {claims.length >= 50 ? <p className={styles.metadata}>50 statements selected. Deselect one to choose another.</p> : null}
    <details className={styles.transcript}><summary>Transcript</summary>
      {review.library.transcript.segments.map(segment => <p key={segment.segmentIndex}><time>{reviewTime(segment.startMs)}–{reviewTime(segment.endMs)}</time> {segment.text}</p>)}
      {!review.library.transcript.segments.length ? <p>No transcript segments available.</p> : null}
    </details>
  </div>;
}
