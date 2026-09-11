import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

const mocks = vi.hoisted(() => ({ available: vi.fn(), hydrate: vi.fn(), hash: vi.fn(), context: vi.fn(), extract: vi.fn() }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: vi.fn(() => ({})) }));
vi.mock('@/lib/media/source-hydration', () => ({ hydrateCreativeSourceSelections: mocks.hydrate }));
vi.mock('@/lib/video/library-service', () => ({ videoSourceHash: mocks.hash }));
vi.mock('@/lib/video/preview-availability', () => ({ assertDurableVideoIntelligenceAvailable: mocks.available }));
vi.mock('@/lib/video/selection-context', () => ({ loadVideoSelectionContext: mocks.context, extractVideoSelectionFrames: mocks.extract }));
import { approveHumanFrame, changeApprovedHumanActive, readApprovedHumanPreview, resolveApprovedHumanFrame, requireActiveHumanSelection } from '@/lib/video/approved-human-service';
import { listApprovedHumanFrames } from '@/lib/video/approved-human-store';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const pngHash = createHash('sha256').update(png).digest('hex');
const mediaId = `media_${'a'.repeat(32)}`;
const libraryId = `video-library:${'b'.repeat(64)}`;
const frameId = `video-frame:${'c'.repeat(64)}`;
const sourceHash = 'd'.repeat(64);
const input = { mediaId, selection: { libraryId, sourceVideoContentHash: sourceHash, frameIds: [frameId] },
  previewPngSha256: pngHash, description: 'Presenter with room for copy; identity only, no claims.' };
const provenance = { frameIndex: 0, libraryFrameId: frameId, candidateFrameSha256: 'e'.repeat(64), timestampMs: 1000, approvedPngSha256: pngHash };
class MemoryStorage implements VideoIntelligenceStorage {
  data = new Map<string, { bytes: Buffer; etag: string }>();
  async read(key: string) { return this.data.get(key) ?? null; }
  async write(key: string, bytes: Buffer, expected: string | null) {
    if ((this.data.get(key)?.etag ?? null) !== expected) return false;
    this.data.set(key, { bytes, etag: String(Number(expected ?? 0) + 1) }); return true;
  }
}
beforeEach(() => {
  vi.resetAllMocks();
  const source = { role: 'TRA_VIDEO', media: { id: mediaId, fileName: 'TRA presenter.mp4' }, stored: {} };
  mocks.hydrate.mockResolvedValue([source]); mocks.hash.mockReturnValue(sourceHash);
  mocks.context.mockResolvedValue({ library: { id: libraryId }, manifest: {} });
  mocks.extract.mockResolvedValue({ source, frames: [{ buffer: png, frameSha256: pngHash }], selectionProvenance: [provenance] });
});

describe('approved-human source boundary', () => {
  it('requires current approval and exact saved selection for revision reuse', async () => {
    const storage = new MemoryStorage(); const record = await approveHumanFrame(input, 'operator', storage);
    await expect(requireActiveHumanSelection(record.id, record.source, storage)).resolves.toEqual(record);
    await expect(requireActiveHumanSelection(record.id, { ...record.source, sourceVideoContentHash: 'f'.repeat(64) }, storage)).rejects.toThrow('matches');
    await changeApprovedHumanActive(record.id, false, storage);
    await expect(requireActiveHumanSelection(record.id, record.source, storage)).rejects.toThrow('inactive');
  });
  it('approves a fresh preview-bound PNG and always re-extracts before reuse', async () => {
    const storage = new MemoryStorage();
    const record = await approveHumanFrame(input, 'operator', storage);
    expect(record).toMatchObject({ active: true, approvedBy: 'operator', sourceName: 'TRA presenter.mp4',
      source: { libraryId, sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash, frames: [provenance] } });
    expect(await readApprovedHumanPreview(record.id, storage)).toEqual(png);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect((await resolveApprovedHumanFrame(record.id, storage)).selected.frames[0].buffer).toEqual(png);
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(mocks.extract).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), [frameId]);
  });
  it('never approves a thumbnail or stale PNG and writes no approval on failure', async () => {
    const storage = new MemoryStorage();
    await expect(approveHumanFrame({ ...input, previewPngSha256: 'f'.repeat(64) }, 'operator', storage)).rejects.toThrow('preview');
    mocks.extract.mockResolvedValue({ frames: [{ buffer: Buffer.from('jpeg'), frameSha256: pngHash }], selectionProvenance: [provenance] });
    await expect(approveHumanFrame(input, 'operator', storage)).rejects.toThrow('preview');
    expect(storage.data.size).toBe(0);
  });
  it('rejects changed source/library and unavailable originals instead of using cached previews', async () => {
    const storage = new MemoryStorage(); const record = await approveHumanFrame(input, 'operator', storage);
    mocks.hash.mockReturnValue('f'.repeat(64));
    await expect(resolveApprovedHumanFrame(record.id, storage)).rejects.toThrow('video changed');
    mocks.hash.mockReturnValue(sourceHash); mocks.context.mockResolvedValue(null);
    await expect(resolveApprovedHumanFrame(record.id, storage)).rejects.toThrow('library');
    mocks.hydrate.mockRejectedValue(new Error('Source missing'));
    await expect(resolveApprovedHumanFrame(record.id, storage)).rejects.toThrow('Source missing');
    expect(mocks.extract).toHaveBeenCalledTimes(1);
  });
  it('deactivates without the source, but blocks reuse and requires fresh validation for reactivation', async () => {
    const storage = new MemoryStorage(); const record = await approveHumanFrame(input, 'operator', storage);
    mocks.extract.mockRejectedValueOnce(new Error('Source unavailable'));
    await changeApprovedHumanActive(record.id, false, storage);
    await expect(resolveApprovedHumanFrame(record.id, storage)).rejects.toThrow('inactive');
    await expect(changeApprovedHumanActive(record.id, true, storage)).rejects.toThrow('unavailable');
    expect((await listApprovedHumanFrames(storage))[0].active).toBe(false);
    const reactivated = await changeApprovedHumanActive(record.id, true, storage);
    expect(reactivated).toMatchObject({ active: true, approvedBy: record.approvedBy, approvedAt: record.approvedAt, source: record.source });
  });
  it('rejects candidate/timestamp drift even when the PNG bytes are unchanged', async () => {
    const storage = new MemoryStorage(); const record = await approveHumanFrame(input, 'operator', storage);
    const selected = await mocks.extract();
    mocks.extract.mockResolvedValue({ ...selected, selectionProvenance: [{ ...provenance, timestampMs: 2000 }] });
    await expect(resolveApprovedHumanFrame(record.id, storage)).rejects.toThrow('provenance changed');
  });
  it('keeps a corrupted cached preview out of curation without making it a generation source', async () => {
    const storage = new MemoryStorage(); const record = await approveHumanFrame(input, 'operator', storage);
    storage.data.set(`approved-humans/v1/previews/${record.id}.png`, { bytes: Buffer.from('broken'), etag: '2' });
    await expect(readApprovedHumanPreview(record.id, storage)).rejects.toThrow('unavailable');
    await expect(resolveApprovedHumanFrame(record.id, storage)).resolves.toHaveProperty('selected');
  });
});
