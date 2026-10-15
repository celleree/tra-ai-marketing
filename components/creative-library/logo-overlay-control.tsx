'use client';
import { useRef, useState } from 'react';
import { readStoredBrandLogo, type StoredBrandLogo } from '@/lib/creatives/brand-logo';
import { CREATIVE_LOGO_ANCHORS, type CreativeLogoAnchor } from '@/lib/creatives/logo-placement';
import { createSubmissionIdentity, SUBMISSION_HEADER } from '@/lib/creatives/submission-id';
import type { CreativeRecord } from '@/lib/creatives/generated';

export function LogoOverlayControl({ creative, onSaved }: { creative: Pick<CreativeRecord, 'id' | 'planning' | 'generationProvenance'>; onSaved: (creative: CreativeRecord) => void }) {
  const [open, setOpen] = useState(false), [logo, setLogo] = useState<StoredBrandLogo | null>(null);
  const [anchor, setAnchor] = useState<CreativeLogoAnchor>(creative.planning?.logoAnchor ?? 'top-left');
  const [busy, setBusy] = useState(false), [authRequired, setAuthRequired] = useState(false), [error, setError] = useState('');
  const [saved, setSaved] = useState<CreativeRecord | null>(null);
  const submission = useRef(createSubmissionIdentity('logo-overlay')), submitting = useRef(false);
  if (creative.generationProvenance?.logoOverlaySource) return null;
  const save = async () => {
    if (!logo || submitting.current || authRequired || saved) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const body = JSON.stringify({ logoMediaId: logo.mediaId, anchor });
      const key = await submission.current.forInput(`${creative.id}:${body}`);
      const response = await fetch(`/api/creatives/${creative.id}/logo`, { method: 'POST', headers: { 'Content-Type': 'application/json', [SUBMISSION_HEADER]: key }, body });
      if (response.status === 401 || response.status === 403) {
        setAuthRequired(true); throw new Error(response.status === 401 ? 'Sign in to save this logo-only version. The original is unchanged.' : 'This account cannot save logo-only versions. The original is unchanged.');
      }
      const payload = await response.json();
      if (!response.ok || !payload.creative) throw new Error(payload.error || 'Logo save is unconfirmed. Reload the library before trying the same save again.');
      const next = payload.creative as CreativeRecord;
      if (next.identity?.parentCreativeId !== creative.id || next.generationProvenance?.logoOverlaySource?.mediaId !== logo.mediaId
        || next.generationProvenance?.revision?.logoOverlay?.anchor !== anchor) throw new Error('Saved logo version did not match this action. Reload the library.');
      onSaved(next); setSaved(next); submission.current.complete(key);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Logo save is unconfirmed. Reload the library.';
      setError(message.startsWith('Cannot retain this paid action') ? 'Cannot retain this logo save safely. Enable session storage before retrying.' : message);
    } finally { submitting.current = false; setBusy(false); }
  };
  return <section aria-label="Original logo overlay">
    <button type="button" disabled={busy || authRequired} onClick={() => { const stored=readStoredBrandLogo();
      setLogo(stored ? { ...stored, url: stored.url.match(/\/api\/media\/files\/media_[a-f0-9]{32}\.(?:png|jpg|webp)/)?.[0] ?? '' } : null); setOpen(true); }}>Add saved logo without AI</button>
    {open ? <>
      <p>Save a separate copy with the original logo. The image, person and claim text stay unchanged outside the logo panel. No AI call is made.</p>
      {!logo ? <p role="alert">The saved original logo is missing. Restore it in Company &gt; Brand Guidelines.</p> : <>
        <img src={logo.url} alt="Saved original TRA logo" style={{ maxWidth: 180, height: 'auto' }} />
        <label>Logo position <select value={anchor} disabled={busy || authRequired || Boolean(saved)} onChange={event => setAnchor(event.target.value as CreativeLogoAnchor)}>
          {CREATIVE_LOGO_ANCHORS.map(value => <option key={value} value={value}>{value.replace('-', ' ')}</option>)}</select></label>
        <button type="button" disabled={busy || authRequired || Boolean(saved)} onClick={() => void save()}>{busy ? 'Saving logo-only version.' : 'Save logo-only version'}</button>
      </>}
      {error ? <p role="alert">{error}</p> : null}
      {saved ? <div role="status"><p>Logo-only version saved. Original preserved.</p><img src={saved.image.url} alt="New creative with original TRA logo" style={{ maxWidth: '100%', height: 'auto' }} /></div> : null}
    </> : null}
  </section>;
}
