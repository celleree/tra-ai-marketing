'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { caseAmendmentOptions, proposeCaseAmendment, VideoCasePair } from '@/lib/creatives/portfolio-case-amendment';
import type { WorkspaceAccessObserver } from '@/lib/auth/workspace-access-client';

type Options = ReturnType<typeof caseAmendmentOptions>;
type Proposal = ReturnType<typeof proposeCaseAmendment>;
const endpoint = '/api/creatives/portfolios/case-amendment';

export function PortfolioCaseAmendment({ id, observeAccess, onClose, onSaved }: { id: string;
  observeAccess: WorkspaceAccessObserver; onClose: () => void; onSaved: () => void }) {
  const [options, setOptions] = useState<Options | null>(null);
  const [pairs, setPairs] = useState<VideoCasePair[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [applied, setApplied] = useState(false);
  const mounted = useRef(true);
  const request = useCallback(async (method: string, body?: object) => {
    const response = await fetch(body ? endpoint : `${endpoint}?id=${encodeURIComponent(id)}`, {
      method, cache: 'no-store', signal: AbortSignal.timeout(30_000),
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    observeAccess('portfolio-case-amendment', response.status);
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Reload saved progress before amending this portfolio.');
    return value;
  }, [id, observeAccess]);
  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const value = await request('GET');
      if (!mounted.current) return;
      if (value.applied) { setApplied(true); return; }
      setOptions(value); setPairs(value.slots.map((slot: { index: number }) => ({ slotIndex: slot.index,
        claimIndex: -1, frameId: '', attributionConfirmed: false })));
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not load saved cases.'); }
    finally { if (mounted.current) setBusy(false); }
  }, [request]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  const choose = (index: number, change: Partial<VideoCasePair>) => {
    setProposal(null);
    setPairs(current => current.map((pair, position) => position === index ? { ...pair, ...change } : pair));
  };
  const submit = async (save: boolean) => {
    setBusy(true); setError('');
    try {
      const value = await request(save ? 'PATCH' : 'POST', save ? { id, amendment: proposal!.amendment } : { id, pairs });
      if (!mounted.current) return;
      if (save) { setApplied(true); onSaved(); } else setProposal(value);
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not amend the saved cases.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <section aria-label="Video case amendment">
    <h3>Use selected video cases</h3>
    <p>Choose the case statement and its person for each image. The original plan and supplied layouts stay saved. Previewing and saving this amendment start no AI calls; Resume is separate.</p>
    {error ? <p role="alert">{error}</p> : null}
    {applied ? <p role="status">Case amendment saved. Reload saved progress before choosing whether to Resume generation.</p> : <>
      {options ? <><p>{options.attributionNotice}</p>{pairs.map((pair, index) => {
        const claim = options.claims.find(candidate => candidate.claimIndex === pair.claimIndex);
        const frame = claim?.frames.find(candidate => candidate.frameId === pair.frameId);
        return <fieldset key={pair.slotIndex} disabled={busy} style={{ minWidth: 0 }}>
          <legend>Image {pair.slotIndex}</legend>
          <label>Case statement <select aria-label={`Image ${pair.slotIndex} case statement`} style={{ width: '100%', maxWidth: '100%', fontSize: 16 }} value={pair.claimIndex}
            onChange={event => choose(index, { claimIndex: Number(event.target.value), frameId: '', attributionConfirmed: false })}>
            <option value={-1}>Choose a saved video statement</option>
            {options.claims.map(candidate => <option key={candidate.claimIndex} value={candidate.claimIndex}>{candidate.wording}</option>)}
          </select></label>
          {claim ? <p>{claim.wording}</p> : null}
          <label>Person frame <select aria-label={`Image ${pair.slotIndex} person frame`} style={{ width: '100%', maxWidth: '100%', fontSize: 16 }} value={pair.frameId}
            onChange={event => choose(index, { frameId: event.target.value, attributionConfirmed: false })}>
            <option value="">Choose a frame from this statement</option>
            {claim?.frames.map(candidate => <option key={candidate.frameId} value={candidate.frameId}>{(candidate.timestampMs / 1000).toFixed(3)}s — {candidate.observation.summary}</option>)}
          </select></label>
          {frame ? <p>Cached observation, {frame.observationIsExactFrame ? 'exact frame' : 'nearby representative'}: {frame.observation.summary} {frame.observation.uncertainties.join(' ')}</p> : null}
          <label><input type="checkbox" checked={pair.attributionConfirmed} disabled={!frame}
            onChange={event => choose(index, { attributionConfirmed: event.target.checked })} /> I reviewed the source video and confirmed this case statement belongs to this person.</label>
        </fieldset>;
      })}</> : null}
      {proposal ? <div aria-label="Proposed case copy">{proposal.creatives.map(concept => <p key={concept.index}><strong>Image {concept.index}:</strong> {concept.imageCopy?.shortSupport}</p>)}
        <p>No new transcription, planner or audit. At most {proposal.providerOperations.maximumFrameAssessments} frame assessments and {proposal.providerOperations.maximumPrimaryImages} primary images after a separate Resume; no fallback images.</p>
        <button type="button" disabled={busy || !pairs.every(pair => pair.attributionConfirmed)} onClick={() => { void submit(true); }}>Save amendment without generating</button>
      </div> : null}
      <button type="button" disabled={busy || !options || pairs.some(pair => !pair.frameId || pair.claimIndex < 0)} onClick={() => { void submit(false); }}>Preview amendment without generating</button>
      <button type="button" disabled={busy} onClick={() => { void load(); }}>Reload saved cases</button>
    </>}
    <button type="button" disabled={busy} onClick={onClose}>Close case amendment</button>
  </section>;
}
