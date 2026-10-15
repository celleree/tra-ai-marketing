vi.mock('server-only', () => ({}));
import { describe, expect, it, vi } from 'vitest';
import { changeAnthropicCredential, getAnthropicCredential, getProviderSecretStatus } from '@/lib/provider-secrets/anthropic';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
const masterKey = Buffer.alloc(32, 7).toString('base64');
const dummy = 'sk-ant-offline_dummy_0123456789';
function fixture() {
  const records = new Map<string, { bytes: Buffer; etag: string }>(); let counter = 0;
  const storage: VideoIntelligenceStorage = {
    read: async key => records.get(key) ?? null,
    write: async (key, bytes, expected) => {
      if ((records.get(key)?.etag ?? null) !== expected) return false;
      records.set(key, { bytes, etag: String(++counter) }); return true;
    },
  };
  return { records, deps: { storage, masterKey } };
}
describe('private provider credential vault (dummy keys only)', () => {
  it('sets, rotates, removes and recreates without exposing plaintext or accepting stale state', async () => {
    const { records, deps } = fixture();
    expect(await getProviderSecretStatus('alice', deps)).toEqual({ configured: false, revision: null, updatedAt: null });
    const first = await changeAnthropicCredential('alice', dummy, null, deps);
    expect(first.configured).toBe(true); expect(JSON.stringify(first)).not.toContain(dummy);
    expect([...records.values()][0].bytes.toString()).not.toContain(dummy);
    expect([...records.keys()][0]).toMatch(/^provider-secrets\/v1\/[a-f0-9]{64}\/anthropic.json$/);
    expect(await getAnthropicCredential('alice', deps)).toBe(dummy);
    await expect(changeAnthropicCredential('alice', dummy, null, deps)).rejects.toMatchObject({ code: 'conflict' });
    const second = await changeAnthropicCredential('alice', `${dummy}_rotated`, first.revision, deps);
    expect(second.revision).not.toBe(first.revision);
    await expect(changeAnthropicCredential('alice', null, first.revision, deps)).rejects.toMatchObject({ code: 'conflict' });
    const removed = await changeAnthropicCredential('alice', null, second.revision, deps);
    expect(removed.configured).toBe(false); expect(await getAnthropicCredential('alice', deps)).toBeNull();
    await expect(changeAnthropicCredential('alice', dummy, null, deps)).rejects.toMatchObject({ code: 'conflict' });
    expect((await changeAnthropicCredential('alice', dummy, removed.revision, deps)).configured).toBe(true);
  });
  it('binds ciphertext to operator/provider and rejects tampering/wrong master keys', async () => {
    const { records, deps } = fixture();
    await changeAnthropicCredential('alice', dummy, null, deps);
    expect(await getAnthropicCredential('bob', deps)).toBeNull();
    await expect(getAnthropicCredential('alice', { ...deps, masterKey: Buffer.alloc(32, 8).toString('base64') })).rejects.toMatchObject({ code: 'unavailable' });
    const alice = [...records.values()][0];
    const { createHash } = await import('node:crypto');
    records.set(`provider-secrets/v1/${createHash('sha256').update('bob').digest('hex')}/anthropic.json`, alice);
    await expect(getAnthropicCredential('bob', deps)).rejects.toMatchObject({ code: 'unavailable' });
    const envelope = JSON.parse(alice.bytes.toString()); envelope.tag = Buffer.alloc(16).toString('base64');
    alice.bytes = Buffer.from(JSON.stringify(envelope));
    await expect(getAnthropicCredential('alice', deps)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('fails closed for missing/invalid configuration, CAS conflict and storage errors', async () => {
    const { deps } = fixture();
    await expect(changeAnthropicCredential('alice', dummy, null, { ...deps, masterKey: '' })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(changeAnthropicCredential('alice', 'bad key', null, deps)).rejects.toMatchObject({ code: 'invalid_input' });
    deps.storage.write = async () => false;
    await expect(changeAnthropicCredential('alice', dummy, null, deps)).rejects.toMatchObject({ code: 'conflict' });
    deps.storage.read = async () => { throw new Error(dummy); };
    await expect(getAnthropicCredential('alice', deps)).rejects.toThrow('Provider credential: unavailable');
  });
});
