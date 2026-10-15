import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseSubmissionId, SubmissionConflictError } from '@/lib/creatives/submission-id';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

type Checkpoint = { version: 1; input: unknown; safeToResume: boolean; token: string; expiresAt: number;
  status: 'RUNNING' | 'COMPLETE' | 'UNKNOWN' | 'RETRY'; value?: unknown };
export class CheckpointUnavailableError extends Error {
  constructor(readonly status: 202 | 409, message: string) { super(message); }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const unavailable = () => { throw new CheckpointUnavailableError(409, 'Saved execution state is unavailable. No repeat provider work is authorized.'); };

export function submissionRunId(operatorId: string, submissionId: string, operation: string): string {
  const id = parseSubmissionId(submissionId);
  if (!id || !operatorId || !operation) throw new SubmissionConflictError('Invalid submission identity.');
  return hash(JSON.stringify([operation, operatorId, id]));
}

/** JSON results only. Provider-capable work is never reclaimed after failure or expiry.
 * safeToResume is exclusively for deterministic work whose every paid call has its own durable admission.
 */
export async function runDurableCheckpoint<T>(runId: string, step: string, input: unknown,
  work: (assertCurrent: () => Promise<void>) => Promise<T>,
  options: { storage?: VideoIntelligenceStorage; safeToResume?: boolean; now?: () => number } = {}): Promise<T> {
  if (!runId || runId.length > 200 || !step || step.length > 200) return unavailable();
  const storage = options.storage ?? getVideoIntelligenceStorage(), now = options.now ?? Date.now;
  const key = `paid-operation-checkpoints/v1/${hash(runId)}/${hash(step)}.json`;
  const normalizedInput = jsonCopy(input), safeToResume = options.safeToResume === true;
  const read = async () => {
    const stored = await storage.read(key);
    if (!stored) return null;
    try {
      if (stored.bytes.length > 8 * 1024 * 1024) return unavailable();
      const value = JSON.parse(stored.bytes.toString()) as Checkpoint;
      if (value.version !== 1 || !('input' in value) || typeof value.safeToResume !== 'boolean'
        || typeof value.token !== 'string' || !value.token || !Number.isSafeInteger(value.expiresAt)
        || !['RUNNING', 'COMPLETE', 'UNKNOWN', 'RETRY'].includes(value.status)
        || (value.status === 'COMPLETE' && !('value' in value))
        || (value.status === 'RETRY' && !value.safeToResume)) return unavailable();
      if (!isDeepStrictEqual(value.input, normalizedInput) || value.safeToResume !== safeToResume) {
        throw new SubmissionConflictError('Submission inputs changed. Start a new intentional action.');
      }
      return { ...stored, value };
    } catch (error) {
      if (error instanceof SubmissionConflictError) throw error;
      return unavailable();
    }
  };
  const encode = (value: Checkpoint) => {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 8 * 1024 * 1024) return unavailable();
    return bytes;
  };
  let owned: Checkpoint | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await read();
    if (current?.value.status === 'COMPLETE') return jsonCopy(current.value.value) as T;
    if (current?.value.status === 'RUNNING' && current.value.expiresAt > now()) {
      throw new CheckpointUnavailableError(202, 'This submission is still running. Retry delivery with the same submission identity.');
    }
    if (current && (!safeToResume || current.value.status === 'UNKNOWN')) {
      throw new CheckpointUnavailableError(409, 'A provider outcome is unknown. Automatic repurchase is disabled.');
    }
    const next: Checkpoint = { version: 1, input: normalizedInput, safeToResume, token: randomUUID(),
      expiresAt: now() + 10 * 60_000, status: 'RUNNING' };
    if (await storage.write(key, encode(next), current?.etag ?? null)) { owned = next; break; }
  }
  if (!owned) return unavailable();
  const token = owned.token;
  const requireOwned = async () => {
    const current = await read();
    if (current?.value.token !== token || current.value.status !== 'RUNNING' || current.value.expiresAt <= now()) return unavailable();
    return current;
  };
  try {
    const value = jsonCopy(await work(async () => { await requireOwned(); }));
    const current = await requireOwned();
    if (!await storage.write(key, encode({ ...owned, status: 'COMPLETE', value }), current.etag)) return unavailable();
    return value;
  } catch (error) {
    // Lost completion acknowledgement may already be COMPLETE. Never overwrite it.
    const current = await read();
    if (current?.value.token === token && current.value.status === 'RUNNING') {
      await storage.write(key, encode({ ...owned, status: safeToResume ? 'RETRY' : 'UNKNOWN' }), current.etag);
    }
    throw error;
  }
}
