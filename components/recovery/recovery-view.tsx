'use client';
import { useEffect, useState } from 'react';
import type { CreativeRecord } from '@/lib/creatives/generated';

export function RecoveryView() {
  const [records, setRecords] = useState<CreativeRecord[]>([]), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/creatives', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to view saved work.' : 'Saved work could not be loaded. No records were changed.');
      const payload = await response.json();
      if (!Array.isArray(payload.items)) throw new Error('Saved work returned an invalid response.');
      setRecords(payload.items);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, []);
  return <main style={{ maxWidth: 1000, margin: 'auto', padding: 24 }}>
    <h1>Read-only recovery</h1>
    <p>Saved creatives and media remain available. Editing, generation and publishing are paused.</p>
    <p>Source, video review and generation metadata remain stored unchanged; this recovery view shows saved images and copy only.</p>
    {error ? <p role="alert">{error}</p> : <p>{records.length} saved creatives</p>}
    {records.map(record => <article key={record.id} style={{ marginBlock: 24 }}>
      <h2>{record.copy.headline}</h2>
      <img src={record.image.url} alt={record.copy.headline} style={{ maxWidth: '100%', maxHeight: 600, objectFit: 'contain' }} />
      <p>{record.copy.primaryText}</p><p>{record.copy.description}</p>
      <a href={record.image.url} download>Download saved image</a>
    </article>)}
  </main>;
}
