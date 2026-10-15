'use client';
import { useEffect, useRef, useState } from 'react';
import type { WanMode, WanResolution, WanSummary } from '@/lib/video-generation/wan/types';
import { uploadTraVideo } from '@/lib/video/upload-client';

async function json<T>(response: Response): Promise<T> {
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'AI Videos request failed.'); return value;
}
/** Use the existing private upload/confirm boundary; no provider media transfer occurs here. */
async function uploadImage(file: File): Promise<string> {
  const metadata = { fileName: file.name, mimeType: file.type, size: file.size, sourceRole: 'TRA_REFERENCE' };
  const plan = await json<{ direct: boolean; uploadUrl?: string; media?: { id: string } }>(await fetch('/api/media/upload-url', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata),
  }));
  if (plan.direct === false) {
    const form = new FormData(); form.append('file', file); form.append('sourceRole', 'TRA_REFERENCE');
    return (await json<{ id: string }>(await fetch('/api/media/upload', { method: 'POST', body: form }))).id;
  }
  if (!plan.uploadUrl || !plan.media?.id) throw new Error('Image upload could not be prepared.');
  const result = await fetch(plan.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!result.ok) throw new Error('Image upload failed.');
  await json(await fetch('/api/media/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaId: plan.media.id, mimeType: file.type, mediaType: 'IMAGE', sourceRole: 'TRA_REFERENCE' }) }));
  return plan.media.id;
}
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const fieldStyle = { display: 'grid', minWidth: 0, gap: 6, marginBottom: 16 } as const;
const inputStyle = { background: '#111827', color: '#f8fafc', border: '1px solid #475569', padding: 10, borderRadius: 8, width: '100%', minWidth: 0, maxWidth: '100%' } as const;
const buttonStyle = { minHeight: 44, border: '1px solid #64748b', borderRadius: 8, padding: '10px 16px', background: '#223046', color: '#fff', cursor: 'pointer', maxWidth: '100%', overflowWrap: 'anywhere' } as const;
export function AIVideosWorkspace() {
  const [jobs, setJobs] = useState<WanSummary[]>([]);
  const [access, setAccess] = useState(false); const [paid, setPaid] = useState(false); const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [name, setName] = useState(''); const [notes, setNotes] = useState('');
  const [image, setImage] = useState<File | null>(null); const [video, setVideo] = useState<File | null>(null);
  const [mode, setMode] = useState<WanMode>('MOVE'); const [resolution, setResolution] = useState<WanResolution>('480p');
  const [selected, setSelected] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selected) dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus(); }, [selected]);
  const [rights, setRights] = useState(false); const [transfer, setTransfer] = useState(false); const [cost, setCost] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const upsert = (job: WanSummary) => setJobs(current => [job, ...current.filter(item => item.id !== job.id)].sort((a, b) => b.createdAt - a.createdAt));
  async function restore() {
    const data = await json<{ accessEnabled: boolean; paidEnabled: boolean; jobs: WanSummary[] }>(await fetch('/api/ai-videos', { cache: 'no-store' }));
    setAccess(data.accessEnabled); setPaid(data.paidEnabled); setJobs(data.jobs);
  }
  useEffect(() => { void restore().catch(e => setError(e.message)).finally(() => setLoading(false)); const timer = setInterval(() => setClock(Date.now()), 10_000); return () => clearInterval(timer); }, []);
  async function operation(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); } finally { setBusy(false); } }
  async function quote() {
    await operation(async () => {
      if (!image || !video) throw new Error('Choose a character image and source MP4.');
      const imageId = await uploadImage(image); const videoId = (await uploadTraVideo(video)).id;
      const result = await json<{ job: WanSummary }>(await fetch('/api/ai-videos', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: { name, notes }, imageId, videoId, mode, resolution }) }));
      upsert(result.job); setSelected(result.job.id); setRights(false); setTransfer(false); setCost(false);
    });
  }
  async function act(job: WanSummary, action: 'launch' | 'refresh') {
    await operation(async () => {
      const result = await json<{ job: WanSummary }>(await fetch(`/api/ai-videos/${job.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, quoteId: job.quote.id, rightsConfirmed: rights, providerTransferConfirmed: transfer, estimatedCostConfirmed: cost }) }));
      upsert(result.job); if (action === 'launch') setSelected(null);
    });
  }
  const chosen = jobs.find(job => job.id === selected);
  return <section aria-labelledby="wan-title" style={{ padding: 24, color: '#e2e8f0', background: '#101827', borderRadius: 16, maxWidth: 1100, minWidth: 0, overflowWrap: 'anywhere', margin: '0 auto' }}>
    <h1 id="wan-title">AI Videos</h1>
    <p>Wan Animate transfers movement from a source video to a character image. Move animates your character; Replace substitutes the subject in the source scene.</p>
    <p style={{ color: '#94a3b8' }}>Fal Wan 2.2 · Images may be center-cropped · Audio preservation and voice cloning are not guaranteed or provided.</p>
    {loading ? <p role="status">Restoring private jobs…</p> : !access && <p role="status">AI Videos is disabled. An administrator must approve access and provider activation before use.</p>}
    {access && !paid && <p role="status">Paid generation is disabled. You can prepare quotes and inspect saved jobs; no generation can launch.</p>}
    {error && <p role="alert" style={{ color: '#fda4af' }}>{error}</p>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 28 }}>
      <form style={{ minWidth: 0 }} onSubmit={event => { event.preventDefault(); void quote(); }}>
        <fieldset disabled={busy || !access || loading} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <legend><h2>Character and source</h2></legend>
          <label style={fieldStyle}>Character profile name<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} style={inputStyle} /></label>
          <label style={fieldStyle}>Profile notes<textarea maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} style={inputStyle} /><small>Organizational notes only. Wan does not receive a text prompt.</small></label>
          <label style={fieldStyle}>Character image<input required style={{ width: '100%', maxWidth: '100%', minWidth: 0 }} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => setImage(e.target.files?.[0] || null)} /></label>
          <label style={fieldStyle}>Motion source MP4<input required style={{ width: '100%', maxWidth: '100%', minWidth: 0 }} type="file" accept="video/mp4" onChange={e => setVideo(e.target.files?.[0] || null)} /><small>Maximum 30 seconds, 1800 decoded frames, 100 MB.</small></label>
          <label style={fieldStyle}>Mode<select value={mode} onChange={e => setMode(e.target.value as WanMode)} style={inputStyle}><option value="MOVE">Move — character follows source motion</option><option value="REPLACE">Replace — character replaces source subject</option></select></label>
          <label style={fieldStyle}>Resolution<select value={resolution} onChange={e => setResolution(e.target.value as WanResolution)} style={inputStyle}><option>480p</option><option>580p</option><option>720p</option></select></label>
          <button type="submit" style={buttonStyle}>{busy ? 'Working…' : 'Upload privately and prepare quote'}</button>
        </fieldset>
      </form>
      <div style={{ minWidth: 0 }}><h2>Private job history</h2>
        <button type="button" disabled={busy || loading} style={buttonStyle} onClick={() => void operation(restore)}>Restore jobs</button>
        {!jobs.length && <p>No saved jobs yet. Upload sources to prepare an estimate.</p>}
        {jobs.map(job => <article key={job.id} style={{ padding: 16, border: '1px solid #475569', borderRadius: 12, marginTop: 14 }}>
          <h3>{job.profile.name}</h3><p>{job.mode} · {job.resolution} · <strong>{job.state}</strong></p>
          {job.profile.notes && <p>{job.profile.notes}</p>}
          <p>Estimated {money(job.quote.estimatedCents)} · {job.quote.frames} decoded frames</p>
          <small>{new Date(job.createdAt).toLocaleString()} · {job.id}</small>
          {job.message && <p role="status">{job.message}</p>}
          {job.outputUrl && <video aria-label={`${job.profile.name} generated video`} controls preload="metadata" src={job.outputUrl} style={{ width: '100%', marginTop: 12 }} />}
          {job.state === 'QUOTED' && <p><button type="button" style={buttonStyle} disabled={busy || !paid || clock >= job.quote.expiresAt} onClick={() => { setSelected(job.id); setRights(false); setTransfer(false); setCost(false); }}>{clock >= job.quote.expiresAt ? 'Quote expired — prepare a new one' : 'Review launch'}</button></p>}
          {['SUBMITTING', 'IN_QUEUE', 'IN_PROGRESS', 'RECOVERY'].includes(job.state) && <p><button type="button" disabled={busy} style={buttonStyle} onClick={() => void act(job, 'refresh')}>Refresh / resume accepted request</button></p>}
          {job.state === 'UNKNOWN' && <p>Automatic resubmission is blocked. Ask an administrator to reconcile the provider request and charges.</p>}
        </article>)}
      </div>
    </div>
    {chosen?.state === 'QUOTED' && <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="wan-confirm" onKeyDown={event => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); setSelected(null); }
      if (event.key === 'Tab') {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }} style={{ position: 'fixed', inset: 0, background: '#020617ed', display: 'grid', placeItems: 'start center', overflowY: 'auto', padding: 24, zIndex: 50 }}>
      <div style={{ maxWidth: 580, width: '100%', minWidth: 0, background: '#172033', padding: 24, borderRadius: 16 }}>
        <h2 id="wan-confirm">Confirm Wan generation</h2>
        <p>{chosen.profile.name} · {chosen.mode} · {chosen.resolution} · {chosen.quote.frames} decoded source frames</p>
        <p>Estimate: <strong>{money(chosen.quote.estimatedCents)} USD</strong>. Pricing version {chosen.quote.pricingVersion}; expires {new Date(chosen.quote.expiresAt).toLocaleTimeString()}.</p>
        <p>This estimate is not a confirmed bill or a provider-enforced spending cap. Fal receives the character image and source video, with private output ACLs and a requested one-hour output retention. A verified server callback captures completed output even if you close this page. If all capture attempts fail before permanent deletion, the provider output cannot be recovered.</p>
        <label style={fieldStyle}><span><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)} /> I have source, likeness and movement rights and required consent.</span></label>
        <label style={fieldStyle}><span><input type="checkbox" checked={transfer} onChange={e => setTransfer(e.target.checked)} /> I consent to transferring these sources to Fal for this job.</span></label>
        <label style={fieldStyle}><span><input type="checkbox" checked={cost} onChange={e => setCost(e.target.checked)} /> I approve this estimated cost for one generation attempt.</span></label>
        <button type="button" style={buttonStyle} onClick={() => setSelected(null)} disabled={busy}>Cancel</button>{' '}
        <button type="button" style={buttonStyle} disabled={busy || !paid || !rights || !transfer || !cost || clock >= chosen.quote.expiresAt} onClick={() => void act(chosen, 'launch')}>Launch paid generation</button>
      </div>
    </div>}
  </section>;
}
