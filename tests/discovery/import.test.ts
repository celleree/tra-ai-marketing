import { describe, expect, it, vi } from 'vitest';
import { storeSelectedImage } from '@/lib/discovery/import';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import type { MediaStorage } from '@/lib/media/storage';
import sharp from 'sharp';
const file = async (name = 'image.png') => new File([new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#abcdef' } }).png().toBuffer())], name, { type: 'image/png' });
function fixture() {
  const records = new Map<string, { bytes: Buffer; etag: string }>();
  const artifacts: VideoIntelligenceStorage = {
    read: async key => records.get(key) ?? null,
    write: async (key, bytes, expected) => { if ((records.get(key)?.etag ?? null) !== expected) return false; records.set(key, { bytes, etag: `${records.size + 1}` }); return true; },
  };
  let sequence = 0; const files = new Set<string>();
  const save = vi.fn(async () => { const id = `media_${++sequence}`; files.add(`${id}.png`); return { id, fileName: `${id}.png`, originalName: 'fixture', mimeType: 'image/png', size: 8, url: `/api/media/files/${id}.png` }; });
  const remove = vi.fn(async (name: string) => { files.delete(name); });
  const media = { saveImage: save, readImage: async (name: string) => files.has(name) ? {} : null, deleteImage: remove } as unknown as MediaStorage;
  return { artifacts, media, records, save, remove };
}
describe('operator-scoped identical-byte imports', () => {
  it('reuses identical bytes across different source file names and sessions', async () => {
    const dependencies = fixture(); const first = await storeSelectedImage('operator-A', await file(), dependencies), second = await storeSelectedImage('operator-A', await file('different-source.png'), dependencies);
    expect(second.media.id).toBe(first.media.id); expect(second.reused).toBe(true); expect(second.imageSha256).toHaveLength(64); expect(dependencies.save).toHaveBeenCalledTimes(1);
  });
  it('separates operators and rejects invalid image bytes before saving', async () => {
    const dependencies = fixture(); await storeSelectedImage('operator-A', await file(), dependencies); await storeSelectedImage('operator-B', await file(), dependencies);
    expect([...dependencies.records.keys()].filter(key => key.includes('/images/'))).toHaveLength(2); expect([...dependencies.records.keys()].every(key => !key.includes('operator-'))).toBe(true);
    await expect(storeSelectedImage('operator-A', new File(['not image'], 'x.png', { type: 'image/png' }), dependencies)).rejects.toThrow(); expect(dependencies.save).toHaveBeenCalledTimes(2);
  });
  it('preserves media on an uncertain artifact write so an accepted receipt cannot reference deleted data', async () => {
    const dependencies = fixture(); dependencies.artifacts.write = async () => { throw new Error('connection lost'); };
    await expect(storeSelectedImage('operator-A', await file(), dependencies)).rejects.toThrow('connection lost'); expect(dependencies.remove).not.toHaveBeenCalled();
  });
});
