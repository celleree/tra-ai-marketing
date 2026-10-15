'use client';
import { useEffect, useRef, useState } from 'react';
import type { Candidate } from '@/lib/discovery/model';
import type { DiscoverySession } from '@/lib/discovery/storage';
import { visualSimilarity } from '@/lib/discovery/similarity';
type Result = { session?: DiscoverySession; sessionId?: string; runId?: string; error?: string; notice?: string; providerAvailable?: boolean; visualAnalysisAvailable?: boolean; imported?: string };
const rememberSession = (id: string) => { try { sessionStorage.setItem('tra-discovery-session', id); } catch { /* Storage is optional. */ } };
export function CreativeDiscoveryWorkspace() {
  const [query, setQuery] = useState('free consultation'), [limit, setLimit] = useState(10), [preferTax, setPreferTax] = useState(true);
  const [session, setSession] = useState<DiscoverySession>(), [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string[]>([]), [rights, setRights] = useState(false), [feedbackOptIn, setFeedbackOptIn] = useState(false);
  const [uploads, setUploads] = useState<Record<string, File>>({});
  const [analysisAvailable, setAnalysisAvailable] = useState(false), [approveAnalysis, setApproveAnalysis] = useState(false), [patternQuery, setPatternQuery] = useState('');
  const inFlight = useRef(false), searchGeneration = useRef(0);
  useEffect(() => {
    let active = true;
    fetch('/api/discovery').then(response => response.json()).then((body: Result) => { if (active) { setAvailable(body.providerAvailable === true); setAnalysisAvailable(body.visualAnalysisAvailable === true); if (body.error) setError(body.error); } }).catch(() => { if (active) setError('Discovery status is unavailable.'); });
    let id: string | null = null; try { id = sessionStorage.getItem('tra-discovery-session'); } catch { /* Optional recovery hint. */ }
    const generation = searchGeneration.current;
    if (id) fetch(`/api/discovery?session=${encodeURIComponent(id)}`).then(response => response.json()).then((body: Result) => { if (active && generation === searchGeneration.current && body.session) setSession(body.session); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const call = async (payload: Record<string, unknown>, file?: File) => {
    let body: string | FormData = JSON.stringify(payload);
    if (file) { const form = new FormData(); for (const [key, value] of Object.entries(payload)) form.set(key, String(value)); form.set('image', file); body = form; }
    const response = await fetch('/api/discovery', { method: 'POST', headers: file ? undefined : { 'Content-Type': 'application/json' }, body });
    const result = await response.json() as Result;
    if (result.sessionId) rememberSession(result.sessionId);
    if (!response.ok || result.error) throw new Error(`${result.error || 'Discovery request failed.'}${result.runId ? ` Provider run: ${result.runId}.` : ''}${result.sessionId ? ` Recovery session: ${result.sessionId}.` : ''}`);
    if (result.session) { setSession(result.session); rememberSession(result.session.id); } if (result.notice) setNotice(result.notice); return result;
  };
  const perform = async (operation: () => Promise<unknown>) => { if (inFlight.current) return; inFlight.current = true; setBusy(true); setError(''); setNotice(''); try { await operation(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Discovery request failed.'); } finally { inFlight.current = false; setBusy(false); } };
  const search = (sample: boolean) => perform(async () => { searchGeneration.current++; setSelected([]); setUploads({}); setRights(false); setApproveAnalysis(false); setPatternQuery(''); await call({ action: sample ? 'sample' : 'search', query, limit, preferTax }); });
  const importSelected = () => perform(async () => {
    const imported: string[] = [];
    try { for (const id of selected) { await call({ action: 'import', sessionId: session!.id, candidateId: id, confirmRights: rights }, uploads[id]); imported.push(id); } }
    finally { setSelected(current => current.filter(id => !imported.includes(id))); if (imported.length) setNotice(`${imported.length} selected reference(s) imported. No paid classification was performed.`); }
  });
  const feedback = (candidate: Candidate, decision: string) => perform(() => call({ action: 'feedback', sessionId: session!.id, candidateId: candidate.id, optIn: feedbackOptIn, decision }));
  const visualMatches = (id: string) => {
    const fingerprint = session?.fingerprints?.[id];
    return fingerprint ? Object.entries(session?.fingerprints ?? {}).filter(([other]) => other !== id).flatMap(([other, value]) => { const match = visualSimilarity(fingerprint, value); return match ? [`${match.kind} with ${other} (distance ${match.distance})`] : []; }) : [];
  };
  return <section className="discovery-workspace" aria-label="Creative discovery" style={{ display: 'grid', gap: 16, padding: 24, minWidth: 0, overflowWrap: 'anywhere' }}>
    <style>{'.discovery-workspace button { min-height:44px; padding:8px 12px; } .discovery-workspace input:not([type=checkbox]) { display:block; max-width:100%; min-height:40px; } .discovery-workspace label { line-height:1.6; }'}</style>
    <header><h2>Creative discovery</h2><p>Find transferable copy, offers, angles, and layouts across industries. Prefer tax context when useful.</p></header>
    <p role="status">{available ? 'Live provider search is enabled and can incur charges.' : 'Live provider disabled. Authorized access and paid-execution approval are required. Explore fictional samples without provider calls.'}</p>
    <form onSubmit={event => { event.preventDefault(); void search(false); }} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
      <label>Keywords or advertiser context<input aria-label="Discovery keywords" value={query} maxLength={160} onChange={event => setQuery(event.target.value)} required /></label>
      <label>Results (1–100)<input aria-label="Discovery result count" type="number" min={1} max={100} value={limit} onChange={event => setLimit(Number(event.target.value))} /></label>
      <label><input type="checkbox" checked={preferTax} onChange={event => setPreferTax(event.target.checked)} /> Prefer tax context</label>
      <button disabled={busy || !available}>Search provider (paid)</button>
      <button type="button" disabled={busy || !query.trim() || limit < 1 || limit > 100} onClick={() => void search(true)}>Explore offline samples</button>
    </form>
    <p>Try “free consultation”, “checklist”, “customer problem”, or an offer from another industry. Keyword matching cannot verify layout or human presence; inspect the source creative. Dates and activity never establish spend, profitability, or a winner.</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {session && <>
      <p>{session.sample ? 'Fictional samples — metadata only, no real ads or images.' : `Run ${session.run?.id ?? 'unknown'} · ${session.run?.status ?? 'unknown'}`} · {session.exactDuplicates} duplicate image URL(s) hidden.</p>
      {session.submission && session.submission !== 'submitted' && <p role="alert">Submission status is {session.submission}. Check the provider console before starting another paid search.</p>}
      {session.run && <button disabled={busy || !available} onClick={() => void perform(() => call({ action: 'refresh', sessionId: session.id }))}>Refresh run / load results</button>}
      {session.run && ['FAILED', 'ABORTED', 'TIMED-OUT'].includes(session.run.status) && <p role="alert">Provider run did not complete. Review its status before starting another paid run.</p>}
      {!session.candidates.length && <p>{session.run && !['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(session.run.status) ? 'Search is running. Refresh to check completion.' : 'No supported image results. Try different keywords. Nothing was imported.'}</p>}
      <label><input type="checkbox" checked={feedbackOptIn} onChange={event => setFeedbackOptIn(event.target.checked)} /> Save my approval feedback privately for this operator (optional)</label>
      {!session.sample && <><p>{analysisAvailable ? 'Optional visual analysis is enabled and incurs a model charge.' : 'Optional visual analysis is paused until server analysis and image-transfer approvals are configured.'}</p>
        <label><input type="checkbox" checked={approveAnalysis} onChange={event => setApproveAnalysis(event.target.checked)} disabled={!analysisAvailable} /> I approve the image transfer and paid model analysis when I press Analyze on a result.</label></>}
      <label>Filter reviewed patterns (layout, offer, angle, human presence)<input value={patternQuery} onChange={event => { setPatternQuery(event.target.value); setSelected([]); }} placeholder="e.g. GRID, free-consultation, present" /></label>
      {patternQuery && <p>Filters search inferred pattern labels only. Unanalyzed visual fields stay unknown; no matching evidence means no displayed cards.</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        {session.candidates.filter(candidate => !patternQuery.trim() || JSON.stringify({ ...candidate.inference, ...session.visualEvidence?.[candidate.id] }).toLowerCase().includes(patternQuery.trim().toLowerCase())).map(candidate => <article key={candidate.id} style={{ border: '1px solid #d1d5db', borderRadius: 12, padding: 16 }}>
          <h3>{candidate.advertiser}</h3>
          {!session.sample && available && <img src={`/api/discovery/preview?session=${encodeURIComponent(session.id)}&candidate=${encodeURIComponent(candidate.id)}`} alt={`Reference creative from ${candidate.advertiser}`} loading="lazy" style={{ width: '100%', maxHeight: 320, objectFit: 'contain' }} />}
          {!session.sample && <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">Inspect source creative · Ad {candidate.adId}</a>}
          <p>{candidate.text || 'Creative copy unavailable.'}</p>
          <p>Provider-reported status: {candidate.status}<br />Start: {candidate.startDate ?? 'unknown'} · End: {candidate.endDate ?? 'unknown'}<br />Observed: {candidate.observedAt}</p>
          <p>Why shown: {candidate.reasons.join('; ')}.</p>
          <p>Copy heuristic (unverified): {candidate.inference.angle}; offer cue: {candidate.inference.offer}. Layout: unknown. Human presence: unknown. Performance: unknown.</p>
          {session.visualEvidence?.[candidate.id] && <p>Visual model inference: layout {session.visualEvidence[candidate.id].layout}; human presence {session.visualEvidence[candidate.id].humanPresence}; offer {session.visualEvidence[candidate.id].offer}; angle {session.visualEvidence[candidate.id].angle}. Model {session.visualEvidence[candidate.id].model} · {session.visualEvidence[candidate.id].analyzedAt} · Image SHA-256 {session.visualEvidence[candidate.id].imageSha256}. This is interpretation, not verified evidence of rights, claims, or performance.</p>}
          {!session.sample && <button disabled={busy || !analysisAvailable || !approveAnalysis || Boolean(session.analysisAttempts?.[candidate.id])} onClick={() => void perform(() => call({ action: 'analyze', sessionId: session.id, candidateId: candidate.id, approveTransfer: approveAnalysis }))}>Analyze visual pattern (paid)</button>}
          {session.analysisAttempts?.[candidate.id] && session.analysisAttempts[candidate.id] !== 'succeeded' && <p>Analysis attempt: {session.analysisAttempts[candidate.id]}. Check the provider console before attempting further paid work.</p>}
          {candidate.nearDuplicateOf && <p>Possible copy variant of {candidate.nearDuplicateOf}. Visual similarity has not been checked.</p>}
          <p>{session.fingerprints?.[candidate.id] ? `Visual fingerprint inspected. ${visualMatches(candidate.id).join('; ') || 'No flagged match among inspected images in this session.'}` : 'Visual similarity unknown: image has not been inspected yet.'}</p>
          {session.similarImports?.[candidate.id]?.map(match => <p key={match.mediaId}>Imported-image match: {match.kind} with {match.mediaId} (dHash distance {match.distance}). Possible variants require manual review; this does not establish performance.</p>)}
          {candidate.duplicateSources?.map(source => <p key={source.adId}>Same image also observed in <a href={source.sourceUrl} target="_blank" rel="noreferrer">Ad {source.adId}</a>.</p>)}
          {!session.sample && <><label><input type="checkbox" disabled={busy} checked={selected.includes(candidate.id)} onChange={event => setSelected(current => event.target.checked ? [...current, candidate.id] : current.filter(id => id !== candidate.id))} /> Select for import</label>
            <label style={{ display: 'block' }}>Optional manual image if source download fails<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; setUploads(current => { const next = { ...current }; if (file) next[candidate.id] = file; else delete next[candidate.id]; return next; }); }} /></label></>}
          <div><button disabled={busy || !feedbackOptIn} onClick={() => void feedback(candidate, 'approved')}>Approve reference idea</button> <button disabled={busy || !feedbackOptIn} onClick={() => void feedback(candidate, 'rejected')}>Reject idea</button></div>
          {session.feedback[candidate.id] && <p>Your private feedback: {session.feedback[candidate.id]}</p>}
          {session.imports[candidate.id] && <p>Image saved: {session.imports[candidate.id].id}. Retry import to ensure library registration if an earlier request failed.</p>}
        </article>)}
      </div>
      {!session.sample && <><label><input type="checkbox" checked={rights} onChange={event => setRights(event.target.checked)} /> I may store these images as layout references. This does not authorize using a person’s identity or copying claims.</label>
        <button disabled={busy || !rights || !selected.length} onClick={() => void importSelected()}>Import {selected.length} selected reference(s)</button></>}
    </>}
    <p>TRA performance feedback is unavailable: no authoritative account metrics or attribution links are connected. Approval records reflect your judgment only. No automated buying, publishing, or winner prediction.</p>
  </section>;
}
