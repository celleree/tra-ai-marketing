export type PortfolioPauseReason = 'hidden' | 'pagehide' | 'navigation' | 'explicit-stop' | 'error' | 'unknown';
type ContinuationState = PortfolioPauseReason | 'active';
const key = (id: string) => 'tax-marketing-studio-portfolio-continuation-v1:' + id;
const reasons = new Set(['hidden', 'pagehide', 'navigation', 'explicit-stop', 'error', 'unknown', 'active']);

/** Browser-local explanation only; never an authorization or server progress record. */
export function readPortfolioPause(id: string): PortfolioPauseReason | null {
  try {
    const value = window.localStorage.getItem(key(id));
    return value && reasons.has(value) ? value === 'active' ? 'unknown' : value as PortfolioPauseReason : null;
  } catch { return null; }
}
export function writePortfolioContinuation(id: string, state: ContinuationState | null) {
  try {
    if (state === null) window.localStorage.removeItem(key(id));
    else window.localStorage.setItem(key(id), state);
  } catch { /* Saved server progress and explicit continuation work without local storage. */ }
}
export const portfolioPauseLabel: Record<PortfolioPauseReason, string> = {
  hidden: 'This browser paused continuation when the page became hidden.',
  pagehide: 'This browser paused continuation when the page was left or hidden.',
  navigation: 'This browser paused continuation when leaving the generation view.',
  'explicit-stop': 'Generation was stopped explicitly in this browser.',
  error: 'This browser paused continuation after an error. Reload saved progress before deciding what to do next.',
  unknown: 'The previous continuation in this browser was interrupted; the exact event is unknown.',
};
