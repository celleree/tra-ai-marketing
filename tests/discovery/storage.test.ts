import { beforeEach, describe, expect, it, vi } from 'vitest';
const memory = vi.hoisted(() => ({ records: new Map<string, { bytes: Buffer; etag: string }>(), conflict: false }));
vi.mock('@/lib/runtime/deployment', () => ({ assertDeploymentRuntimeConsistent: () => {} }));
vi.mock('@/lib/video/intelligence-storage', () => ({ LocalVideoIntelligenceStorage: class {
  async read(key: string) { return memory.records.get(key) ?? null; }
  async write(key: string, bytes: Buffer, etag: string | null) {
    if (memory.conflict) {
      memory.conflict = false; const value = JSON.parse(memory.records.get(key)!.bytes.toString()); value.feedback.concurrent = 'approved';
      memory.records.set(key, { bytes: Buffer.from(JSON.stringify(value)), etag: 'concurrent' }); return false;
    }
    if ((memory.records.get(key)?.etag ?? null) !== etag) return false;
    memory.records.set(key, { bytes, etag: `${memory.records.get(key)?.etag ?? ''}next` }); return true;
  }
}, R2VideoIntelligenceStorage: class {} }));
import { loadSession, saveSession, sessionKey, updateSession, type DiscoverySession } from '@/lib/discovery/storage';
const id = 'a'.repeat(32);
const session = (): DiscoverySession => ({ version: 1, id, createdAt: '2026-10-15T00:00:00Z', search: { query: 'tax', limit: 10, preferTax: true }, sample: true, candidates: [], exactDuplicates: 0, imports: {}, feedback: {} });
beforeEach(() => { memory.records.clear(); memory.conflict = false; });
describe('private discovery session conditional writes', () => {
  it('hashes operator identity and never accepts a path as a session identifier', async () => {
    expect(sessionKey('operator-A', id)).not.toContain('operator-A'); expect(sessionKey('operator-A', id)).not.toBe(sessionKey('operator-B', id));
    expect(() => sessionKey('operator-A', '../../index')).toThrow();
    await saveSession('operator-A', session(), null); await expect(loadSession('operator-B', id)).rejects.toThrow('this operator');
  });
  it('rejects stale writes and merges completed inference without overwriting concurrent feedback', async () => {
    await saveSession('operator-A', session(), null); await expect(saveSession('operator-A', session(), null)).rejects.toThrow('another request');
    memory.conflict = true;
    const result = await updateSession('operator-A', id, current => { current.analysisAttempts = { candidate: 'succeeded' }; });
    expect(result.feedback.concurrent).toBe('approved'); expect(result.analysisAttempts?.candidate).toBe('succeeded');
  });
});
