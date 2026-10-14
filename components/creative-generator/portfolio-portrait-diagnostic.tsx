'use client';

import { useEffect, useState } from 'react';
import type { portfolioPortraitDiagnostic } from '@/lib/creatives/portfolio-portrait-diagnostic';
import type { WorkspaceAccessObserver } from '@/lib/auth/workspace-access-client';
type Diagnostic = Awaited<ReturnType<typeof portfolioPortraitDiagnostic>>;

export function PortfolioPortraitDiagnostic({ id, slotIndex, observeAccess }: { id: string; slotIndex: number; observeAccess: WorkspaceAccessObserver }) {
  const [value, setValue] = useState<Diagnostic | null>(null), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/creatives/portfolios/portrait-diagnostic?id=${encodeURIComponent(id)}&slotIndex=${slotIndex}`,
          { cache: 'no-store', signal: controller.signal });
        observeAccess('portfolio-portrait-diagnostic', response.status);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Portrait diagnostic could not be loaded.');
        if (!controller.signal.aborted) setValue(result);
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Portrait diagnostic could not be loaded.'); }
    })();
    return () => controller.abort();
  }, [id, slotIndex, observeAccess]);
  return <section aria-label={`Creative ${slotIndex} portrait diagnostic`}>
    <p>This is a read-only diagnostic. It starts no AI calls, retries or generation.</p>
    {error ? <p role="alert">{error}</p> : !value ? <p role="status">Loading saved assessment and pinned crop…</p> : <>
      <p>Frame: {(value.timestampMs / 1000).toFixed(3)} seconds. Assessment: {value.assessmentStatus}.</p>
      {value.frameIdentity ? <>
        <p>Saved case frame: {(value.frameIdentity.caseTimestampMs / 1000).toFixed(3)} seconds. Selected candidate: {value.frameIdentity.selectedCandidateIndex}.</p>
        <details><summary>Saved frame identity</summary><p>Portfolio: {value.portfolioId}</p>
          <p>Case frame: {value.frameIdentity.caseFrameId}</p><p>Selected frame: {value.frameIdentity.selectedFrameId}</p></details>
      </> : null}
      {value.originalDimensions ? <p>Uncropped source PNG: {value.originalDimensions.width} x {value.originalDimensions.height} pixels. Crop coordinates are relative to this extracted PNG.</p> : null}
      {value.cropDecision ? <p>Saved crop decision: {value.cropDecision.status}{value.cropDecision.status === 'EDGE_CROP'
        ? `, ${value.cropDecision.edge}, removal ${value.cropDecision.removePermille}/1000, deepest mark ${value.cropDecision.overlayDepthPermille}/1000` : ''}.</p> : null}
      <p>Crop: {value.crop ? `left ${value.crop.left}, top ${value.crop.top}, width ${value.crop.width}, height ${value.crop.height} pixels` : 'Full frame; no crop.'}</p>
      <p>Failed checks: {value.failedChecks.length ? value.failedChecks.join(', ') : 'None recorded in a completed assessment.'}</p>
      <p>Model reason: {value.assessment?.observableReason || 'No completed assessment is available.'}</p>
      {value.assessment ? <dl>{Object.entries(value.assessment).filter(([key]) => key !== 'observableReason').map(([key, field]) =>
        <div key={key}><dt>{key}</dt><dd>{typeof field === 'object' ? field.status : field}</dd></div>)}</dl> : null}
      {value.png ? <figure><img src={value.png.dataUrl} alt={`Exact assessed portrait crop for Creative ${slotIndex}`} style={{ maxWidth: '100%', height: 'auto' }} />
        <figcaption>Exact pinned PNG: {value.png.width} × {value.png.height} pixels. Model observations require human inspection.</figcaption></figure>
        : <p role="status">{value.previewError}</p>}
      {value.originalPng ? <details><summary>Uncropped source PNG for comparison</summary>
        <img src={value.originalPng.dataUrl} alt={`Exact uncropped source frame for Creative ${slotIndex}`} style={{ maxWidth: '100%', height: 'auto' }} />
        <p>Original source pixels for inspection only. This image is not approved for generation.</p>
      </details> : value.originalPreviewError ? <p>{value.originalPreviewError}</p> : null}
    </>}
  </section>;
}

/** Explicit read-only control beside its failed output; no request until clicked. */
export function PortfolioPortraitDiagnosticAction({ disabled, ...props }: Parameters<typeof PortfolioPortraitDiagnostic>[0] & { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" disabled={disabled} onClick={() => setOpen(true)}>Show portrait diagnostic for Creative {props.slotIndex}</button>
    {open ? <PortfolioPortraitDiagnostic {...props} /> : null}
  </>;
}
