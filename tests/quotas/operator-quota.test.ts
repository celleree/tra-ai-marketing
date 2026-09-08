import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { OPERATOR_QUOTA_POLICY, OperatorQuotaUnavailableError, reserveOperatorQuota } from '@/lib/quotas/operator-quota';

const HOUR = 60 * 60 * 1_000;
const reserve = (units: number, now = 0, storage?: VideoIntelligenceStorage) =>
  reserveOperatorQuota({ operatorId: 'user_123', group: 'CREATIVE_GENERATION', units }, { now: () => now, storage });

describe('operator quota', () => {
  it('uses the approved hourly technical limits', () => {
    expect(OPERATOR_QUOTA_POLICY).toEqual({ WEBSITE_ANALYSIS: 12, FONT_ANALYSIS: 12, CREATIVE_GENERATION: 60,
      CREATIVE_REVISION: 24, VIDEO_SELECTION: 24, VIDEO_PROVIDER_WORK: 120, VIDEO_FRAME_PREVIEW: 30, VIDEO_PREPARATION: 12 });
  });

  it('allows up to the boundary, then returns a fixed-window retry time', async () => {
    const records = new Map<string, { bytes: Buffer; etag: string }>();
    const storage: VideoIntelligenceStorage = {
      read: async (key) => records.get(key) ?? null,
      write: async (key, bytes, expected) => {
        const current = records.get(key);
        if (expected === null ? Boolean(current) : current?.etag !== expected) return false;
        records.set(key, { bytes, etag: String(Number(current?.etag ?? 0) + 1) }); return true;
      },
    };
    expect(await reserve(30, 1_000, storage)).toEqual({ allowed: true });
    expect(await reserve(30, 1_000, storage)).toEqual({ allowed: true });
    expect(await reserve(1, 1_000, storage)).toEqual({ allowed: false, retryAfterSeconds: 3_599 });
    expect([...records.keys()][0]).toMatch(/^quotas\/v1\/0\/[a-f0-9]{64}\/CREATIVE_GENERATION\.json$/);
  });

  it('resets in the next fixed window', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tra-quota-'));
    const storage = new LocalVideoIntelligenceStorage(root);
    try {
      expect(await reserve(60, 0, storage)).toEqual({ allowed: true });
      expect(await reserve(1, HOUR, storage)).toEqual({ allowed: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not oversubscribe a final concurrent slot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tra-quota-'));
    try {
      const storage = new LocalVideoIntelligenceStorage(root);
      const results = await Promise.all([reserve(60, 0, storage), reserve(60, 0, storage)]);
      expect(results.filter((value) => value.allowed)).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { read: async () => { throw new Error('down'); }, write: async () => true },
    { read: async () => ({ bytes: Buffer.from('bad'), etag: '1' }), write: async () => true },
    { read: async () => null, write: async () => false },
  ] satisfies VideoIntelligenceStorage[])('fails closed when durable state is unavailable', async (storage) => {
    await expect(reserve(1, 0, storage)).rejects.toBeInstanceOf(OperatorQuotaUnavailableError);
  });
});
