export const SUBMISSION_HEADER = 'Idempotency-Key';
export function parseSubmissionId(value: string | null): string | null {
  return value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}
export class SubmissionConflictError extends Error {}

export type SubmissionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Persist only a request digest and UUID in this tab; refresh/retry is the same intent. */
export function createSubmissionIdentity(namespace: string, storage: () => SubmissionStorage = () => window.sessionStorage) {
  let currentKey: string | null = null;
  let currentInput: string | null = null;
  const owned = new Map<string, { key: string; input: string }>();
  const pending = new Map<string, { promise: Promise<string>; id?: string; key?: string }>();
  const complete = (id: string) => {
    const value = owned.get(id);
    if (value && storage().getItem(value.key) === id) storage().removeItem(value.key);
    if (value && pending.get(value.input)?.id === id) pending.delete(value.input);
    owned.delete(id);
  };
  return {
    forInput(input: string): Promise<string> {
      currentInput = input;
      const existingPending = pending.get(input);
      if (existingPending) { currentKey = existingPending.key ?? null; return existingPending.promise; }
      let reservation!: { promise: Promise<string>; id?: string; key?: string };
      reservation = { promise: (async () => {
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))))
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
        const key = `tra-paid-intent-v1:${namespace}:${hash}`;
        reservation.key = key;
        if (currentInput === input) currentKey = key;
        try {
          const active = storage(); const existing = active.getItem(key);
          if (existing !== null && !parseSubmissionId(existing)) throw new Error('Invalid saved intent');
          const id = existing ?? crypto.randomUUID();
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
    reset() { if (currentKey) storage().removeItem(currentKey); if (currentInput !== null) pending.delete(currentInput); },
  };
}
