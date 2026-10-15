import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ImageRenderPurpose } from '@/lib/creatives/image-render-request';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

export type ImageAttemptBudget = { purpose: ImageRenderPurpose; primaryLimit: number; fallbackLimit: number };
export type RawImageResult = { sha256: string; byteLength: number };
type Kind = 'primary' | 'fallback';
type Attempt = { fingerprint: string; token: string; expiresAt: number; status: 'RESERVED' | 'COMPLETE' | 'FAILED' | 'UNKNOWN';
  result?: RawImageResult; retryable?: boolean; httpStatus?: number };
type Run = { version: 1; budget: ImageAttemptBudget; attempts: Record<string, Attempt> };
export type ImageAttemptInput = { runId: string; operationId: string; kind: Kind; fingerprint: string; budget: ImageAttemptBudget };
export type ImageAttemptClaim = { status: 'CLAIMED'; token: string }
  | { status: 'COMPLETE'; result: RawImageResult } | { status: 'BUSY' | 'UNKNOWN' }
  | { status: 'FAILED'; retryable: boolean; httpStatus?: number };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const unavailable = () => { throw new Error('Image attempt state is unavailable or inconsistent; no provider work is authorized.'); };
const key = (runId: string) => {
  if (!runId || runId.length > 200) return unavailable();
  return `paid-image-runs/v1/${digest(runId)}.json`;
};
const attemptKey = (operationId: string, kind: Kind) => {
  if (!operationId || operationId.length > 200 || !['primary', 'fallback'].includes(kind)) return unavailable();
  return `${digest(operationId)}:${kind}`;
};
const validBudget = (value: ImageAttemptBudget) => value
  && ['diagnostic', 'staging-smoke', 'production'].includes(value.purpose)
  && Number.isSafeInteger(value.primaryLimit) && value.primaryLimit > 0
  && Number.isSafeInteger(value.fallbackLimit) && value.fallbackLimit >= 0
  && value.fallbackLimit <= value.primaryLimit
  && (value.purpose !== 'diagnostic' || (value.primaryLimit === 1 && value.fallbackLimit === 0));
const validResult = (value: RawImageResult | undefined) => value && hashPattern.test(value.sha256)
  && Number.isSafeInteger(value.byteLength) && value.byteLength > 0;

function parse(bytes: Buffer): Run {
  try {
    if (bytes.length > 512 * 1024) return unavailable();
    const value = JSON.parse(bytes.toString()) as Run;
    if (value.version !== 1 || !validBudget(value.budget) || !value.attempts
      || typeof value.attempts !== 'object' || Array.isArray(value.attempts)) return unavailable();
    const entries = Object.entries(value.attempts);
    for (const [id, attempt] of entries) {
      if (!/^[a-f0-9]{64}:(primary|fallback)$/.test(id) || !attempt || !hashPattern.test(attempt.fingerprint)
        || typeof attempt.token !== 'string' || !attempt.token || !Number.isSafeInteger(attempt.expiresAt)
        || !['RESERVED', 'COMPLETE', 'FAILED', 'UNKNOWN'].includes(attempt.status)
        || (attempt.status === 'COMPLETE' && !validResult(attempt.result))
        || (attempt.retryable !== undefined && typeof attempt.retryable !== 'boolean')
        || (attempt.httpStatus !== undefined && (!Number.isInteger(attempt.httpStatus)
          || attempt.httpStatus < 400 || attempt.httpStatus > 599))) return unavailable();
    }
    for (const kind of ['primary', 'fallback'] as const) {
      if (entries.filter(([id]) => id.endsWith(`:${kind}`)).length > value.budget[`${kind}Limit`]) return unavailable();
    }
    return value;
  } catch { return unavailable(); }
}

async function change<T>(runId: string, storage: VideoIntelligenceStorage,
  update: (run: Run | null) => { run: Run; result: T }): Promise<T> {
  const path = key(runId);
  for (let retry = 0; retry < 4; retry++) {
    const stored = await storage.read(path);
    const current = stored ? parse(stored.bytes) : null;
    const next = update(current && structuredClone(current));
    const bytes = Buffer.from(JSON.stringify(next.run));
    parse(bytes);
    if (isDeepStrictEqual(current, next.run) || await storage.write(path, bytes, stored?.etag ?? null)) return next.result;
  }
  throw new Error('Image attempt changed concurrently; reload before continuing.');
}

/** Reservation and budget consumption are the same CAS write. Never reclaim unknown work. */
export async function reserveImageAttempt(input: ImageAttemptInput, storage = getVideoIntelligenceStorage(), now = Date.now()): Promise<ImageAttemptClaim> {
  if (!validBudget(input.budget) || !hashPattern.test(input.fingerprint) || !Number.isSafeInteger(now)) return unavailable();
  const id = attemptKey(input.operationId, input.kind);
  return change<ImageAttemptClaim>(input.runId, storage, current => {
    const run = current ?? { version: 1, budget: structuredClone(input.budget), attempts: {} };
    if (!isDeepStrictEqual(run.budget, input.budget)) throw new Error('Image run budget is immutable.');
    const existing = run.attempts[id];
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) throw new Error('Image intent inputs changed; start a new intentional operation.');
      if (existing.status === 'COMPLETE') return { run, result: { status: 'COMPLETE', result: existing.result! } };
      if (existing.status === 'FAILED') return { run, result: { status: 'FAILED', retryable: existing.retryable === true,
        ...(existing.httpStatus ? { httpStatus: existing.httpStatus } : {}) } };
      if (existing.status === 'RESERVED' && existing.expiresAt <= now) existing.status = 'UNKNOWN';
      return { run, result: { status: existing.status === 'RESERVED' ? 'BUSY' : existing.status } };
    }
    if (input.kind === 'fallback') {
      const primary = run.attempts[attemptKey(input.operationId, 'primary')];
      if (primary?.status !== 'FAILED' || primary.retryable !== true) {
        throw new Error('Fallback requires a confirmed retryable primary failure.');
      }
    }
    if (Object.keys(run.attempts).filter(id => id.endsWith(`:${input.kind}`)).length >= run.budget[`${input.kind}Limit`]) {
      throw new Error('Image run attempt budget is exhausted.');
    }
    const token = randomUUID();
    run.attempts[id] = { fingerprint: input.fingerprint, token, status: 'RESERVED', expiresAt: now + 10 * 60_000 };
    return { run, result: { status: 'CLAIMED', token } };
  });
}

/** Late confirmed results can reconcile UNKNOWN, but never authorize a second purchase. */
export async function settleImageAttempt(input: Pick<ImageAttemptInput, 'runId' | 'operationId' | 'kind'> & { token: string },
  outcome: { status: 'COMPLETE'; result: RawImageResult } | { status: 'FAILED'; retryable: boolean; httpStatus?: number } | { status: 'UNKNOWN' },
  storage = getVideoIntelligenceStorage()) {
  const id = attemptKey(input.operationId, input.kind);
  return change(input.runId, storage, run => {
    const attempt = run?.attempts[id];
    if (!run || !attempt || attempt.token !== input.token) return unavailable();
    if (attempt.status === outcome.status && (outcome.status !== 'COMPLETE' || isDeepStrictEqual(attempt.result, outcome.result))) {
      return { run, result: undefined };
    }
    if (!['RESERVED', 'UNKNOWN'].includes(attempt.status)) throw new Error('Image attempt is already settled.');
    if (outcome.status === 'COMPLETE' && !validResult(outcome.result)) return unavailable();
    run.attempts[id] = { fingerprint: attempt.fingerprint, token: attempt.token, expiresAt: attempt.expiresAt, ...outcome };
    return { run, result: undefined };
  });
}
