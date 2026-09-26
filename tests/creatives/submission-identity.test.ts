import { describe, expect, it } from 'vitest';
import { createSubmissionIdentity, parseSubmissionId } from '@/lib/creatives/submission-id';

describe('browser submission lifecycle', () => {
  it('retains identity until completion, then permits deliberate new work', () => {
    const state = createSubmissionIdentity(); const first = state.forInput('same request');
    expect(parseSubmissionId(first)).toBe(first);
    // A failed or interrupted request never calls complete.
    expect(state.forInput('same request')).toBe(first);
    state.complete('unrelated completion'); expect(state.forInput('same request')).toBe(first);
    state.complete(first); expect(state.forInput('same request')).not.toBe(first);
  });
  it('allocates a new intent when selected frames, placement or other request content changes', () => {
    const state = createSubmissionIdentity(); const first = state.forInput('frames A');
    expect(state.forInput('frames B')).not.toBe(first);
  });
});
