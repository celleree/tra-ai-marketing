'use client';

import { useState, type FormEvent } from 'react';
import { readStoredRuntimeCompanyProfile } from '@/lib/company/creative-context';
import type { CreativeRecord } from '@/lib/creatives/generated';
import type { CreativeRevisionRequest } from '@/lib/creatives/revision-request';
import { CREATIVE_PLACEMENTS, CREATIVE_PLACEMENT_SPECS, type CreativePlacement } from '@/lib/creatives/placements';
import styles from '@/components/creative-generator/creative-results.module.css';

export function RevisionControls({ creative, onSaved }: { creative: CreativeRecord; onSaved: (creative: CreativeRecord) => void }) {
  const [operation, setOperation] = useState<CreativeRevisionRequest['operation']>('EDIT');
  const [instruction, setInstruction] = useState('');
  const [placement, setPlacement] = useState<CreativePlacement>('PORTRAIT_4_5');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedId, setSavedId] = useState('');
  const needsInstruction = operation === 'EDIT' || operation === 'VARIATION';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setSavedId('');
    try {
      const companyProfile = readStoredRuntimeCompanyProfile();
      const body: CreativeRevisionRequest = operation === 'PLACEMENT'
        ? { operation, placement, companyProfile }
        : operation === 'REGENERATE' ? { operation, companyProfile }
          : { operation, instruction: instruction.trim(), companyProfile };
      const response = await fetch(`/api/creatives/${creative.id}/revise`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok || !payload.creative) throw new Error(payload.error || 'The new version could not be saved.');
      onSaved(payload.creative as CreativeRecord);
      setSavedId(payload.creative.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The new version could not be saved.');
    } finally { setBusy(false); }
  };

  if (!creative.identity || !creative.planning || !creative.generationProvenance || !creative.placement || !creative.format) {
    return <p className={styles.description}>Generate and save a new creative to enable editing and placement variants.</p>;
  }
  return <details>
    <summary>Create a new version</summary>
    <form onSubmit={submit} aria-busy={busy} style={{ display: 'grid', gap: 12, marginTop: 12 }}>
      <p className={styles.description}>Each result is saved separately. Your original stays in the library.</p>
      <label style={{ display: 'grid', gap: 4 }}>Action
        <select value={operation} disabled={busy} onChange={event => setOperation(event.target.value as CreativeRevisionRequest['operation'])}>
          <option value="EDIT">Edit this creative</option>
          <option value="REGENERATE">Regenerate this concept</option>
          <option value="VARIATION">Create a different variation</option>
          <option value="PLACEMENT">Create a placement variant</option>
        </select>
      </label>
      {needsInstruction ? <label style={{ display: 'grid', gap: 4 }}>{operation === 'EDIT' ? 'Describe your edit' : 'Direction for a different variation'}
        <textarea rows={3} required maxLength={4000} disabled={busy} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder={operation === 'EDIT' ? 'For example: enlarge the headline and move the CTA lower.' : 'For example: focus on taking the next step, using a split layout and minimal graphics.'} />
      </label> : null}
      {operation === 'PLACEMENT' ? <label style={{ display: 'grid', gap: 4 }}>Target image shape
        <select value={placement} disabled={busy} onChange={event => setPlacement(event.target.value as CreativePlacement)}>
          {CREATIVE_PLACEMENTS.map(value => <option key={value} value={value}>{CREATIVE_PLACEMENT_SPECS[value].aspectRatio}</option>)}
        </select>
      </label> : null}
      <button className={styles.primaryButton} type="submit" disabled={busy || (needsInstruction && !instruction.trim())}>{busy ? 'Creating and saving…' : 'Create and save new version'}</button>
      {error ? <p role="alert" className={styles.inlineError}>{error}</p> : null}
      {savedId ? <p role="status">New version saved. <a href={`#${savedId}`}>View new creative</a></p> : null}
    </form>
  </details>;
}
