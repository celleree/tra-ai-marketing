export const SUBMISSION_HEADER = 'Idempotency-Key';
export function parseSubmissionId(value: string | null): string | null {
  return value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}
export class SubmissionConflictError extends Error {}
