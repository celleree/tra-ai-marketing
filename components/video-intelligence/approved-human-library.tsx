'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ApprovedHumanFrame } from '@/lib/video/approved-human';
import type { GenerateVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import styles from './video-intelligence-studio.module.css';

const endpoint = '/api/video/humans';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The human library request failed.';
async function readJson(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The human library request failed.');
  return data;
}

export function HumanFrameApproval({ mediaId, selection, onApproved }: {
  mediaId: string; selection: GenerateVideoFrameSelection; onApproved: () => void;
}) {
  const notesId = useId();
  const [notes, setNotes] = useState('');
  const [preview, setPreview] = useState<{ url: string; hash: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [approved, setApproved] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  async function act(approve: boolean) {
    controller.current?.abort();
    const next = new AbortController(); controller.current = next;
    setBusy(true); setError('');
    try {
      if (approve) {
        if (!preview || !loaded) return;
        await readJson(await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: next.signal,
          body: JSON.stringify({ mediaId, videoFrameSelection: selection, previewPngSha256: preview.hash, description: notes }) }));
        if (!next.signal.aborted) { setApproved(true); onApproved(); }
      } else {
        setPreview(null); setLoaded(false); setApproved(false);
        const response = await fetch('/api/video/intelligence/selected-frame-preview', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, signal: next.signal, body: JSON.stringify({ mediaId, videoFrameSelection: selection }) });
        if (!response.ok) { await readJson(response); return; }
        const hash = response.headers.get('X-TRA-PNG-SHA256');
        if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('The frame preview could not be verified.');
        const blob = await response.blob();
        if (!next.signal.aborted) setPreview({ url: URL.createObjectURL(blob), hash });
      }
    } catch (reason) { if (!next.signal.aborted) setError(errorMessage(reason)); }
    finally { if (!next.signal.aborted) setBusy(false); }
  }

  return <details className={styles.selectedGeneration}>
    <summary>Approve a TRA human for reuse</summary>
    <p>Approve only a clearly visible TRA person. This does not approve claims, credentials, quotes or testimonials.</p>
    <button type="button" className={styles.secondary} disabled={busy} onClick={() => void act(false)}>Preview exact frame</button>
    {preview ? <img src={preview.url} alt="Exact TRA frame for human approval" onLoad={() => setLoaded(true)} onError={() => { setLoaded(false); setError('The frame preview could not be displayed.'); }} /> : null}
    <label htmlFor={notesId}>Appearance, pose and useful framing</label>
    <textarea className={styles.approvalNotes} id={notesId} value={notes} maxLength={500} disabled={busy || approved} onChange={event => setNotes(event.target.value)} />
    <button type="button" className={styles.primary} disabled={busy || !loaded || !notes.trim() || approved} onClick={() => void act(true)}>
      {busy ? 'Working…' : approved ? 'Approved for reuse' : 'Approve this human frame'}
    </button>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {approved ? <p role="status">Saved to the approved TRA human library.</p> : null}
  </details>;
}

export function ApprovedHumanLibrary({ revision }: { revision: number }) {
  const [records, setRecords] = useState<ApprovedHumanFrame[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void fetch(endpoint, { signal: controller.signal }).then(readJson).then(data => {
      if (!controller.signal.aborted) setRecords(data.records);
    }).catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [revision, refresh]);

  async function toggle(record: ApprovedHumanFrame) {
    setBusy(record.id); setError('');
    try {
      const data = await readJson(await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: record.id, active: !record.active }) }));
      setRecords(current => current.map(item => item.id === record.id ? data.record : item));
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(null); }
  }
  return <section className={styles.panel}>
    <div className={styles.sectionHeading}><h2>Approved TRA humans</h2>
      <button type="button" className={styles.secondary} disabled={!!busy} onClick={() => setRefresh(value => value + 1)}>Refresh human library</button></div>
    <p className={styles.muted}>Reusable frames of real TRA people. Deactivated frames retain their source history.</p>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {!records.length && !error ? <p>Load an analyzed TRA video and approve a clearly visible person from a frame below.</p> : null}
    <div className={styles.frameGrid}>{records.map(record => <article key={record.id} className={styles.frame}>
      <img loading="lazy" src={`${endpoint}?preview=${encodeURIComponent(record.id)}`} alt={record.description} />
      <strong>{record.sourceName}</strong>
      <p>{(record.source.frames[0].timestampMs / 1000).toFixed(2)}s · {record.active ? 'Active' : 'Inactive'}</p>
      <p>{record.description}</p>
      <small>Source: {record.source.sourceVideoMediaId}</small>
      <button type="button" className={styles.secondary} disabled={!!busy} onClick={() => void toggle(record)}>
        {busy === record.id ? 'Working…' : record.active ? 'Deactivate' : 'Reactivate'}
      </button>
    </article>)}</div>
  </section>;
}
