import type { CreativePlanningMetadata } from '@/lib/creatives/planning-metadata';

export function DraftVideoSourceNotice({ planning }: { planning?: CreativePlanningMetadata }) {
  const assertion = planning?.draftSourceAssertion;
  if (!assertion) return null;
  const stamp = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  return <details>
    <summary>Video statement · {stamp(assertion.startMs)}–{stamp(assertion.endMs)} · Review required</summary>
    <p>This draft uses the supplied video statement. It has not been independently verified. Confirm the statement, its qualifications and permission before publishing or reuse.</p>
    <blockquote>{assertion.exactText}</blockquote>
    <p>Source video: {assertion.sourceMediaId}. Context is bounded; review the original passage for further qualifications.</p>
    {assertion.uncertainties.length ? <ul>{assertion.uncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
  </details>;
}
