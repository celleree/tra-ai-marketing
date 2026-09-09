'use client';

import { useState, type FormEvent } from 'react';
import type { CreativeRecord } from '@/lib/creatives/generated';
import { CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS, CREATIVE_HUMAN_REVIEW_CHECKLIST_LABELS, type CreativeHumanReviewChecklist } from '@/lib/creatives/human-review';
import { CREATIVE_PLACEMENT_SPECS } from '@/lib/creatives/placements';
import { getCreativeSafeRect } from '@/lib/creatives/safe-zones';
import styles from '@/components/creative-generator/creative-results.module.css';

function StoriesReviewGuide({ creative }: { creative: CreativeRecord }) {
  const [show, setShow] = useState(false);
  if (creative.placement !== 'VERTICAL_9_16') return null;
  const safe = getCreativeSafeRect(creative.placement);
  const spec = CREATIVE_PLACEMENT_SPECS[creative.placement];
  return <div>
    <button type="button" className={styles.secondaryButton} aria-expanded={show} onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'} Stories safe-zone guide</button>
    {show ? <figure style={{ margin: '12px 0' }}>
      <div style={{ position: 'relative', overflow: 'hidden' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={creative.image.url} alt="Saved creative with Stories safe-zone guide" style={{ display: 'block', width: '100%', height: 'auto' }} />
        <div aria-hidden="true" style={{ position: 'absolute', pointerEvents: 'none', boxSizing: 'border-box', border: '2px solid #facc15', boxShadow: '0 0 0 100vmax rgba(120, 20, 20, 0.45)', left: `${safe.left / spec.width * 100}%`, top: `${safe.top / spec.height * 100}%`, width: `${safe.width / spec.width * 100}%`, height: `${safe.height / spec.height * 100}%` }} />
      </div>
      <figcaption>Keep essential text, CTA, faces and the TRA logo inside the unshaded area. This guide does not change the saved image.</figcaption>
    </figure> : null}
  </div>;
}

export function HumanReviewControls({ creative, onUpdated }: { creative: CreativeRecord; onUpdated: (creative: CreativeRecord) => void }) {
  const review = creative.humanReview;
  const [checks, setChecks] = useState<Partial<CreativeHumanReviewChecklist>>(() => review && review.status !== 'PENDING' ? review.checklist : {});
  const [notes, setNotes] = useState(() => review && review.status !== 'PENDING' ? review.notes || '' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const paused = creative.lifecycle?.status === 'PAUSED';
  const complete = CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS.every(key => checks[key] === 'PASS' || checks[key] === 'FAIL');
  const save = async (body: object) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/creatives/${creative.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok || !payload.creative) throw new Error(payload.error || 'Review state could not be saved.');
      onUpdated(payload.creative as CreativeRecord);
      setNotice('Saved.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Review state could not be saved.'); }
    finally { setBusy(false); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); if (complete) void save({ action: 'REVIEW', checklist: checks, notes }); };
  return <div>
    <p className={styles.description}>Human review: {review?.status?.toLowerCase() || 'pending'} · Library: {paused ? 'paused' : 'active'}</p>
    <details>
      <summary>Review quality and compliance</summary>
      <form onSubmit={submit} aria-busy={busy} style={{ display: 'grid', gap: 12, marginTop: 12 }}>
        <p className={styles.description}>Review the saved image and copy. Every check must pass for approval; a failed check marks the creative rejected. Rejected creatives remain available for revision.</p>
        <StoriesReviewGuide creative={creative} />
        {CREATIVE_HUMAN_REVIEW_CHECKLIST_KEYS.map(key => <label key={key} style={{ display: 'grid', gap: 4 }}>
          {CREATIVE_HUMAN_REVIEW_CHECKLIST_LABELS[key]}
          <select required disabled={busy} value={checks[key] || ''} onChange={event => setChecks(current => ({ ...current, [key]: event.target.value as 'PASS' | 'FAIL' }))}>
            <option value="" disabled>Choose a result</option><option value="PASS">Pass</option><option value="FAIL">Fail</option>
          </select>
        </label>)}
        <label style={{ display: 'grid', gap: 4 }}>Review notes (optional)<textarea rows={3} maxLength={2000} disabled={busy} value={notes} onChange={event => setNotes(event.target.value)} /></label>
        <button type="submit" className={styles.primaryButton} disabled={busy || !complete}>{busy ? 'Saving…' : 'Save human review'}</button>
      </form>
    </details>
    <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void save({ action: 'SET_LIFECYCLE', status: paused ? 'ACTIVE' : 'PAUSED' })}>{paused ? 'Resume in library' : 'Pause in library'}</button>
    <p className={styles.description}>Library pause/resume does not change Meta ads.</p>
    {error ? <p role="alert" className={styles.inlineError}>{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </div>;
}
