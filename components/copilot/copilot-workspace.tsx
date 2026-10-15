'use client';

import { useEffect, useRef, useState } from 'react';
import { CreativeCopilotPanel } from './creative-copilot-panel';
import styles from './creative-copilot-panel.module.css';

type KeyStatus = { ready: boolean; configured: boolean; revision: string | null; updatedAt: string | null };
type Choice = { id: string; copy?: { headline?: string }; identity?: unknown };
export function CopilotWorkspace() {
  const [status, setStatus] = useState<KeyStatus | null>(null), [key, setKey] = useState('');
  const [items, setItems] = useState<Choice[]>([]), [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [refresh, setRefresh] = useState(0);
  const active = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const [keys, creatives] = await Promise.all([
          fetch('/api/copilot/key', { cache: 'no-store', signal: abort.signal }),
          fetch('/api/creatives', { cache: 'no-store', signal: abort.signal }),
        ]);
        if (!keys.ok || !creatives.ok) throw new Error();
        const [keyStatus, saved] = await Promise.all([keys.json(), creatives.json()]);
        if (!abort.signal.aborted) { setStatus(keyStatus); setItems(Array.isArray(saved.items) ? saved.items.filter((item: Choice) => item.identity) : []); }
      } catch { if (!abort.signal.aborted) setMessage('Copilot settings or saved creatives could not be loaded. Refresh to try again.'); }
    })();
    return () => abort.abort();
  }, [refresh]);
  const changeKey = async (remove: boolean) => {
    if (active.current || !status?.ready) return;
    active.current = true; setBusy(true); setMessage('');
    const apiKey = key; setKey('');
    try {
      const response = await fetch('/api/copilot/key', { method: remove ? 'DELETE' : 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: status.revision, ...(remove ? {} : { apiKey }) }) });
      const value = await response.json();
      if (!response.ok) { setMessage(value.error ?? 'Key settings could not be saved.'); if (response.status === 409) setRefresh(value => value + 1); return; }
      setStatus(value); setRefresh(value => value + 1); setMessage(remove ? 'Your saved key was removed.' : 'Your key was saved securely. Saving a key does not enable paid requests.');
    } catch { setMessage('The connection was interrupted. Refresh key status before trying again.'); setRefresh(value => value + 1); }
    finally { active.current = false; setBusy(false); }
  };
  return <section className={styles.panel} aria-label="Claude Copilot workspace">
    <h2>Claude Copilot</h2>
    <p>Explore the next creative test with Claude Sonnet 5.5. Copilot sees saved text and planning, not image pixels. Performance and revenue are unknown.</p>
    <fieldset disabled={busy}>
      <legend>Your Anthropic API key</legend>
      <p>The key is private to your signed-in operator account, encrypted on the server, and never shown again. It is not verified with Anthropic when saved.</p>
      <p role="status">{!status ? 'Loading key status.' : !status.ready ? 'Key storage requires administrator setup.' : status.configured ? `Key saved. Updated ${status.updatedAt}.` : 'No key saved.'}</p>
      <label>New API key <input type="password" autoComplete="off" spellCheck={false} value={key} maxLength={507} onChange={event => setKey(event.target.value)} /></label>
      <button type="button" disabled={!status?.ready || !key} onClick={() => void changeKey(false)}>{status?.configured ? 'Replace saved key' : 'Save key'}</button>
      <button type="button" disabled={!status?.ready || !status.configured} onClick={() => void changeKey(true)}>Remove saved key</button>
      <button type="button" onClick={() => { setKey(''); setRefresh(value => value + 1); }}>Refresh key status</button>
    </fieldset>
    {message ? <p role="status">{message}</p> : null}
    <p>Paid suggestions require separate administrator activation and your approval for each request. Saving a key grants neither. Requests use your own API credits; there is no shared-key fallback.</p>
    <label>Saved creative <select aria-label="Saved creative" value={selected} onChange={event => setSelected(event.target.value)}><option value="">Select a saved creative</option>{items.map(item => <option key={item.id} value={item.id}>{item.copy?.headline || item.id}</option>)}</select></label>
    {!items.length ? <p>Save a generated creative with planning identity to use Copilot.</p> : null}
    {selected ? <CreativeCopilotPanel key={`${selected}:${refresh}`} creativeId={selected} hasIdentity /> : null}
  </section>;
}
