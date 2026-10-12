'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { buildCreativeCompanyContext, formatCreativeCompanyContext, readStoredRuntimeCompanyProfile, type RuntimeCompanyProfileSnapshot } from '@/lib/company/creative-context';
import { parseCopilotRecommendation, type CopilotRecommendationRecord } from '@/lib/copilot/records';
import styles from './creative-copilot-panel.module.css';

export function CreativeCopilotPanel({ creativeId, hasIdentity }: { creativeId: string; hasIdentity: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(false), [available, setAvailable] = useState(false), [checking, setChecking] = useState(false);
  const [model, setModel] = useState(''), [approved, setApproved] = useState(false), [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<RuntimeCompanyProfileSnapshot | undefined>();
  const [error, setError] = useState(''), [result, setResult] = useState<CopilotRecommendationRecord | null>(null);
  const controller = useRef<AbortController | null>(null), submitting = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);
  const approvedText = formatCreativeCompanyContext(buildCreativeCompanyContext(profile));
  const refreshContext = () => { setProfile(readStoredRuntimeCompanyProfile()); setApproved(false); };
  const toggle = async () => {
    if (submitting.current) return;
    controller.current?.abort();
    if (open) { setOpen(false); setChecking(false); return; }
    setOpen(true); refreshContext(); setAvailable(false); setChecking(true); setError('');
    const abort = new AbortController(); controller.current = abort;
    try {
      const response = await fetch('/api/copilot/recommendations', { cache: 'no-store', signal: abort.signal });
      const value = await response.json();
      if (!response.ok || typeof value.available !== 'boolean' || typeof value.model !== 'string') throw new Error();
      if (!abort.signal.aborted) { setAvailable(value.available); setModel(value.model); }
    } catch { if (!abort.signal.aborted) setError('Copilot availability could not be checked. Reopen the panel to try again.'); }
    finally { if (!abort.signal.aborted) setChecking(false); }
  };
  const requestSuggestion = async () => {
    if (submitting.current || !available || !approved) return;
    submitting.current = true; setBusy(true); setError('');
    const abort = new AbortController(); controller.current = abort;
    try {
      const response = await fetch('/api/copilot/recommendations', { method: 'POST', cache: 'no-store', signal: abort.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ creativeId, companyProfile: profile ?? null,
          companyContextApproved: true, allowPaidRequest: true }) });
      const value = await response.json();
      if (!response.ok) { setError(typeof value.error === 'string' ? value.error : 'The suggestion could not be requested.'); return; }
      const { context, model: identity, ...output } = value.recommendation ?? {};
      const parsed = parseCopilotRecommendation(output, context, identity);
      if (!parsed || parsed.context.creatives.length !== 1 || parsed.context.creatives[0].creativeId !== creativeId
        || parsed.context.company.approvedText !== approvedText || parsed.model.provider !== 'anthropic' || parsed.model.model !== model) {
        setError('Copilot returned an incomplete or mismatched suggestion. The previous result is still available.'); return;
      }
      setResult(parsed);
    } catch { if (!abort.signal.aborted) setError('The connection was interrupted. The paid request may have completed; no automatic retry was made.'); }
    finally { submitting.current = false; if (!abort.signal.aborted) setBusy(false); }
  };
  if (!hasIdentity) return <p className="muted">Copilot is unavailable for this older creative. Save a new generated version first.</p>;
  const evidence = (refs: string[]) => refs.map(ref => ref === creativeId ? 'saved creative' : ref === result?.context.company.reference ? 'company context' : 'supplied reference').join(', ');
  return <div className={styles.panel}>
    <button type="button" disabled={busy} aria-expanded={open} aria-controls={id} onClick={() => void toggle()}>
      {open ? 'Close creative copilot' : 'Suggest next creative test'}
    </button>
    {open ? <section id={id} aria-label="Creative copilot" aria-busy={checking || busy}>
      <p>Claude reviews saved text and planning, not the image itself. Performance and revenue are unknown.</p>
      {checking ? <p role="status">Checking copilot availability…</p> : !available ? <p>Copilot is not enabled yet.</p> : null}
      <details><summary>Company context for this request</summary><pre className={styles.context} tabIndex={0}>{approvedText}</pre></details>
      <button type="button" disabled={busy} onClick={refreshContext}>Refresh company context</button>
      <label className={styles.approval}><input type="checkbox" checked={approved} disabled={busy || !available}
        onChange={event => setApproved(event.target.checked)} />I approve this company context for this suggestion.</label>
      <p>This request uses Claude API credits. Results stay in this panel until the page reloads.</p>
      <button type="button" disabled={!available || !approved || busy} onClick={() => void requestSuggestion()}>
        {busy ? 'Requesting suggestion…' : 'Request paid suggestion'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {result ? <div className={styles.result} aria-label="Copilot suggestion" role="region">
        <h4>Observed facts</h4><ul>{result.observations.map((item, index) => <li key={index}>{item.text}<small>Evidence: {evidence(item.evidenceReferences)}</small></li>)}</ul>
        <h4>Inferences</h4><ul>{result.inferences.map((item, index) => <li key={index}>{item.text}<small>Evidence: {evidence(item.evidenceReferences)}</small></li>)}</ul>
        <h4>Unknowns</h4><ul>{result.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul>
        <p>Performance and revenue: unknown.</p>
        {result.action === 'DO_NOTHING' ? <p>No creative test is proposed.</p> : <><h4>Proposed creative test</h4><p>{result.recommendation.text}</p>
          <ol><li>{result.recommendation.soWhat.surfaceMessage}</li><li>{result.recommendation.soWhat.functionalConsequence}</li><li>{result.recommendation.soWhat.meaningfulOutcome}</li></ol></>}
        <p>Requires human creative and compliance review before use. No creative or advertising changes have been made.</p>
        <details><summary>Company context used for this suggestion</summary><pre className={styles.context} tabIndex={0}>{result.context.company.approvedText}</pre></details>
      </div> : null}
    </section> : null}
  </div>;
}
