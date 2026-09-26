'use client';

import { useRef, useState, type FormEvent } from 'react';
import { createSubmissionIdentity, SUBMISSION_HEADER } from '@/lib/creatives/submission-id';
import { readStoredRuntimeCompanyProfile } from '@/lib/company/creative-context';
import type { CreativeRecord, GeneratedCreative } from '@/lib/creatives/generated';
import type { CreativeRevisionRequest } from '@/lib/creatives/revision-request';
import { CREATIVE_PLACEMENTS, CREATIVE_PLACEMENT_SPECS, type CreativePlacement } from '@/lib/creatives/placements';
import styles from '@/components/creative-generator/creative-results.module.css';

type RevisableCreative = Pick<CreativeRecord,
  'id' | 'identity' | 'planning' | 'generationProvenance' | 'placement' | 'format'>;
type OtherRevisionOperation = 'REGENERATE' | 'VARIATION' | 'PLACEMENT';

export function CreativeImageFallbackNotice({ creative }: {
  creative: Pick<GeneratedCreative, 'generationProvenance'>;
}) {
  const routing = creative.generationProvenance?.imageGeneration.routing;
  if (!routing?.fallbackUsed) return null;
  return (
    <p role="status" className={styles.fallbackNotice}>
      A compatible fallback image model was used.
    </p>
  );
}

const canRevise = (creative: RevisableCreative) =>
  Boolean(
    creative.identity &&
    creative.planning &&
    creative.generationProvenance &&
    creative.placement &&
    creative.format
  );

export function RevisionControls({ creative, onSaved, showOtherOperations = true }: {
  creative: RevisableCreative;
  onSaved: (creative: CreativeRecord) => void;
  showOtherOperations?: boolean;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [editInstruction, setEditInstruction] = useState('');
  const [operation, setOperation] = useState<OtherRevisionOperation>('REGENERATE');
  const [instruction, setInstruction] = useState('');
  const [placement, setPlacement] = useState<CreativePlacement>('PORTRAIT_4_5');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<CreativeRecord | null>(null);
  const submission = useRef(createSubmissionIdentity('revision'));
  const lastRequest = useRef<CreativeRevisionRequest | null>(null);
  const submitting = useRef(false);

  const submitRevision = async (body: CreativeRevisionRequest, mode: 'recover' | 'fresh' = 'recover') => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    setSaved(null);
    lastRequest.current = body;
    try {
      const companyProfile = readStoredRuntimeCompanyProfile();
      const requestBody = JSON.stringify({ ...body, companyProfile });
      const submissionId = await submission.current.forInput(`${creative.id}:${requestBody}`, mode);
      const response = await fetch(`/api/creatives/${creative.id}/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [SUBMISSION_HEADER]: submissionId },
        body: requestBody,
      });
      const payload = await response.json();
      if (!response.ok || !payload.creative) {
        throw new Error(payload.error || 'The new version could not be saved.');
      }
      const next = payload.creative as CreativeRecord;
      onSaved(next);
      setSaved(next);
      submission.current.complete(submissionId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The new version could not be saved.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const submitEdit = (event: FormEvent) => {
    event.preventDefault();
    void submitRevision({ operation: 'EDIT', instruction: editInstruction.trim() });
  };

  const submitOther = (event: FormEvent) => {
    event.preventDefault();
    const body: CreativeRevisionRequest = operation === 'PLACEMENT'
      ? { operation, placement }
      : operation === 'REGENERATE'
        ? { operation }
        : { operation, instruction: instruction.trim() };
    void submitRevision(body);
  };

  if (!canRevise(creative)) {
    return <p className={styles.description}>Generate and save a new creative to enable editing and placement variants.</p>;
  }

  return (
    <div className={styles.revisionControls}>
      <button type="button" className={styles.secondaryButton} disabled={busy} aria-expanded={editOpen}
        onClick={() => { setEditOpen(current => !current); setError(''); setSaved(null); }}>
        Edit
      </button>
      {editOpen ? (
        <form onSubmit={submitEdit} aria-busy={busy} className={styles.editForm}>
          <p className={styles.description}>Describe the change. The edited result is saved as a new creative; the original stays unchanged.</p>
          <label><span>What should change?</span>
            <textarea rows={3} required maxLength={4000} disabled={busy} value={editInstruction}
              onChange={event => setEditInstruction(event.target.value)}
              placeholder="For example: enlarge the headline and move the CTA lower." />
          </label>
          <button className={styles.primaryButton} type="submit" disabled={busy || !editInstruction.trim()}>
            {busy ? 'Creating edit…' : 'Create edited creative'}
          </button>
        </form>
      ) : null}

      {showOtherOperations ? (
        <details>
          <summary>More version options</summary>
          <form onSubmit={submitOther} aria-busy={busy} className={styles.editForm}>
            <p className={styles.description}>Each result is saved separately. Your original stays in the library.</p>
            <label>Action
              <select value={operation} disabled={busy} onChange={event => setOperation(event.target.value as OtherRevisionOperation)}>
                <option value="REGENERATE">Regenerate this concept</option>
                <option value="VARIATION">Create a different variation</option>
                <option value="PLACEMENT">Create a placement variant</option>
              </select>
            </label>
            {operation === 'VARIATION' ? <label>Direction for a different variation
              <textarea rows={3} required maxLength={4000} disabled={busy} value={instruction}
                onChange={event => setInstruction(event.target.value)}
                placeholder="For example: use a split layout and minimal graphics." />
            </label> : null}
            {operation === 'PLACEMENT' ? <label>Target image shape
              <select value={placement} disabled={busy} onChange={event => setPlacement(event.target.value as CreativePlacement)}>
                {CREATIVE_PLACEMENTS.map(value => <option key={value} value={value}>{CREATIVE_PLACEMENT_SPECS[value].aspectRatio}</option>)}
              </select>
            </label> : null}
            <button className={styles.primaryButton} type="submit" disabled={busy || (operation === 'VARIATION' && !instruction.trim())}>
              {busy ? 'Creating and saving…' : 'Create and save new version'}
            </button>
          </form>
        </details>
      ) : null}

      {error ? <p role="alert" className={styles.inlineError}>{error}</p> : null}
      {error && !busy && lastRequest.current ? <button type="button" className={styles.secondaryButton}
        onClick={() => void submitRevision(lastRequest.current!, 'fresh')}>
        Start a new paid revision
      </button> : null}
      {saved ? (
        <div className={styles.editedResult} role="status">
          <strong>Edited creative saved.</strong>
          {!showOtherOperations ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={saved.image.url} alt="New edited creative" />
          ) : null}
          <CreativeImageFallbackNotice creative={saved} />
          {showOtherOperations ? <a href={`#${saved.id}`}>View new creative</a> : null}
        </div>
      ) : null}
    </div>
  );
}
