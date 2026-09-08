import { createHash } from 'node:crypto';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

const VERSION = 1, WINDOW_MS = 60 * 60 * 1_000, MAX_RECORD_BYTES = 4 * 1024, CAS_ATTEMPTS = 4;
export const OPERATOR_QUOTA_POLICY = {
  WEBSITE_ANALYSIS: 12, FONT_ANALYSIS: 12, CREATIVE_GENERATION: 60, CREATIVE_REVISION: 24,
  VIDEO_SELECTION: 24, VIDEO_PROVIDER_WORK: 120, VIDEO_FRAME_PREVIEW: 30, VIDEO_PREPARATION: 12,
} as const;
export type OperatorQuotaGroup = keyof typeof OPERATOR_QUOTA_POLICY;
type Record = { version: 1; operatorHash: string; group: OperatorQuotaGroup; windowStartMs: number; usedUnits: number };
type Dependencies = { storage?: VideoIntelligenceStorage; now?: () => number };

export class OperatorQuotaUnavailableError extends Error {
  constructor() { super('Operator quota state is unavailable.'); this.name = 'OperatorQuotaUnavailableError'; }
}

const hash = (operatorId: string) => createHash('sha256').update(operatorId).digest('hex');
const keyFor = (windowStartMs: number, operatorHash: string, group: OperatorQuotaGroup) =>
  `quotas/v1/${windowStartMs}/${operatorHash}/${group}.json`;
const unavailable = () => { throw new OperatorQuotaUnavailableError(); };

const parse = (bytes: Buffer, expected: Omit<Record, 'usedUnits'>, maximum: number): Record => {
  if (bytes.length > MAX_RECORD_BYTES) return unavailable();
  try {
    const value = JSON.parse(bytes.toString('utf8')) as Record;
    if (!value || value.version !== VERSION || value.operatorHash !== expected.operatorHash || value.group !== expected.group
      || value.windowStartMs !== expected.windowStartMs || !Number.isSafeInteger(value.usedUnits)
      || value.usedUnits < 0 || value.usedUnits > maximum) return unavailable();
    return value;
  } catch { return unavailable(); }
};

export async function reserveOperatorQuota(
  { operatorId, group, units }: { operatorId: string; group: OperatorQuotaGroup; units: number },
  dependencies: Dependencies = {},
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const maximum = OPERATOR_QUOTA_POLICY[group];
  if (!Number.isSafeInteger(maximum) || maximum < 1 || !operatorId.trim()
    || !Number.isSafeInteger(units) || units < 1 || units > maximum) return unavailable();
  const now = dependencies.now ?? Date.now;
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp)) return unavailable();
  const windowStartMs = Math.floor(timestamp / WINDOW_MS) * WINDOW_MS;
  const expected = { version: 1 as const, operatorHash: hash(operatorId), group, windowStartMs };
  const key = keyFor(windowStartMs, expected.operatorHash, group);

  try {
    const storage = dependencies.storage ?? getVideoIntelligenceStorage();
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const stored = await storage.read(key);
      const current = stored ? parse(stored.bytes, expected, maximum) : { ...expected, usedUnits: 0 };
      if (current.usedUnits + units > maximum) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowStartMs + WINDOW_MS - timestamp) / 1_000)) };
      }
      const next = Buffer.from(JSON.stringify({ ...expected, usedUnits: current.usedUnits + units }));
      if (await storage.write(key, next, stored?.etag ?? null)) return { allowed: true };
    }
  } catch (error) {
    if (error instanceof OperatorQuotaUnavailableError) throw error;
    return unavailable();
  }
  return unavailable();
}
