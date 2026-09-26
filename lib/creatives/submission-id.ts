export const SUBMISSION_HEADER = 'Idempotency-Key';
export function parseSubmissionId(value: string | null): string | null {
  return value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}
export class SubmissionConflictError extends Error {}

/** Keep transport retries on the same intent; clear only after receiving completion. */
export function createSubmissionIdentity() {
  let pending: { input: string; id: string } | null = null;
  return {
    forInput(input: string) {
      if (!pending || pending.input !== input) pending = { input, id: crypto.randomUUID() };
      return pending.id;
    },
    complete(id: string) { if (pending?.id === id) pending = null; },
    completeGeneration(id: string, requested: number, saved: number, failed: number) {
      if (requested > 0 && saved === requested && failed === 0 && pending?.id === id) pending = null;
    },
    reset() { pending = null; },
  };
}
