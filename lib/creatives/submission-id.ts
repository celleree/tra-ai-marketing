export const SUBMISSION_HEADER = 'Idempotency-Key';
export function parseSubmissionId(value: string | null): string | null {
  return value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}
export class SubmissionConflictError extends Error {}

export type SubmissionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Persist only a request digest and UUID in this tab; refresh/retry is the same intent. */
export function createSubmissionIdentity(namespace: string, storage: () => SubmissionStorage = () => window.sessionStorage) {
  const owned = new Map<string, { key: string; input: string }>();
  const pending = new Map<string, { promise: Promise<string>; id?: string }>();
  const complete = (id: string) => {
    const value = owned.get(id);
    if (value && storage().getItem(value.key) === id) storage().removeItem(value.key);
    if (value && pending.get(value.input)?.id === id) pending.delete(value.input);
    owned.delete(id);
  };
  return {
    forInput(input: string, mode: 'recover' | 'fresh' = 'recover'): Promise<string> {
      const existingPending = pending.get(input);
      if (existingPending && mode === 'recover') return existingPending.promise;
      let reservation!: { promise: Promise<string>; id?: string };
      reservation = { promise: (async () => {
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))))
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
        const key = `tra-paid-intent-v1:${namespace}:${hash}`;
        try {
          const active = storage(); const existing = active.getItem(key);
          if (mode === 'recover' && existing !== null && !parseSubmissionId(existing)) throw new Error('Invalid saved intent');
          const id = mode === 'fresh' ? crypto.randomUUID() : existing ?? crypto.randomUUID();
          active.setItem(key, id); // Must succeed before any paid request can be sent.
          owned.set(id, { key, input }); reservation.id = id;
          return id;
        } catch { throw new Error('Cannot retain this paid action safely in browser session storage. Enable session storage before retrying.'); }
      })() };
      pending.set(input, reservation);
      void reservation.promise.catch(() => { if (pending.get(input) === reservation) pending.delete(input); });
      return reservation.promise;
    },
    complete,
    completeGeneration(id: string, requested: number, saved: number, failed: number) {
      if (requested > 0 && saved === requested && failed === 0) complete(id);
    },
  };
}
