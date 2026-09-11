import { describe, expect, it } from 'vitest';
import { approvedHumanId, listApprovedHumanFrames, saveApprovedHumanFrame, setApprovedHumanActive } from '@/lib/video/approved-human-store';
import { parseApprovedHumanFrame, type ApprovedHumanFrame } from '@/lib/video/approved-human';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

const fixture = (hex = 'a'): ApprovedHumanFrame => {
  const source = { libraryId: `video-library:${hex.repeat(64)}`, sourceVideoMediaId: `media_${hex.repeat(32)}`, sourceVideoContentHash: hex.repeat(64),
    frames: [{ frameIndex: 0, libraryFrameId: `video-frame:${hex.repeat(64)}`, candidateFrameSha256: hex.repeat(64), timestampMs: 1000, approvedPngSha256: 'f'.repeat(64) }] };
  return { version: 1, id: approvedHumanId(source), source, sourceName: 'TRA video', description: 'Approved presenter, room for headline',
    extractionVersion: 'selected-png-v1', approvedBy: 'operator', approvedAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z', active: true };
};
class MemoryStorage implements VideoIntelligenceStorage {
  data: { bytes: Buffer; etag: string } | null = null;
  async read() { return this.data; }
  async write(_key: string, bytes: Buffer, expected: string | null) {
    if ((this.data?.etag ?? null) !== expected) return false;
    this.data = { bytes, etag: `${Number(this.data?.etag ?? 0) + 1}` }; return true;
  }
}
describe('approved human records', () => {
  it('persists stable identity once and retains approval/source provenance across deactivation and reactivation', async () => {
    const storage = new MemoryStorage(); const record = fixture();
    await saveApprovedHumanFrame(record, storage);
    await setApprovedHumanActive(record.id, false, storage, '2026-09-11T00:00:00Z');
    expect((await listApprovedHumanFrames(storage))[0]).toMatchObject({ active: false, source: record.source, approvedBy: 'operator' });
    await saveApprovedHumanFrame({ ...record, approvedBy: 'second-operator', updatedAt: '2026-09-12T00:00:00Z' }, storage);
    expect(await listApprovedHumanFrames(storage)).toEqual([{ ...record, updatedAt: '2026-09-12T00:00:00Z' }]);
  });
  it('preserves simultaneous approvals with the existing CAS storage contract', async () => {
    const storage = new MemoryStorage();
    await Promise.all([saveApprovedHumanFrame(fixture('a'), storage), saveApprovedHumanFrame(fixture('b'), storage)]);
    expect(await listApprovedHumanFrames(storage)).toHaveLength(2);
  });
  it('rejects thumbnail-only, missing PNG provenance, malformed records and corrupt storage', async () => {
    const record = fixture();
    expect(parseApprovedHumanFrame({ ...record, source: { ...record.source, frames: [] } })).toBeNull();
    expect(parseApprovedHumanFrame({ ...record, providerEligible: true })).toBeNull();
    expect(parseApprovedHumanFrame({ ...record, source: { ...record.source, frames: [{ ...record.source.frames[0], approvedPngSha256: '' }] } })).toBeNull();
    const storage = new MemoryStorage(); storage.data = { bytes: Buffer.from('{"version":1,"records":[{}]}'), etag: '1' };
    await expect(listApprovedHumanFrames(storage)).rejects.toThrow('invalid');
  });
});
