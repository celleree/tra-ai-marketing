import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CreativeSourceHydrationError,
  findEligibleProviderImageSource,
  hydrateCreativeSourceSelections,
} from '@/lib/media/source-hydration';
import type { MediaStorage } from '@/lib/media/storage';
import type { StoredCreativeSourceMediaFile } from '@/lib/media/types';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isoBox = (type: string, payload = Buffer.alloc(0)) => {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  payload.copy(box, 8);
  return box;
};
const ftypPayload = Buffer.alloc(16);
ftypPayload.write('isom', 0, 4, 'ascii');
ftypPayload.writeUInt32BE(0x200, 4);
ftypPayload.write('isom', 8, 4, 'ascii');
ftypPayload.write('mp42', 12, 4, 'ascii');
const MP4 = Buffer.concat([
  isoBox('ftyp', ftypPayload),
  isoBox('moov'),
  isoBox('mdat', Buffer.from([0x00])),
]);

const mediaId = (hex: string) => `media_${hex.repeat(32)}`;

const storedImage = (hex: string): StoredCreativeSourceMediaFile => ({
  fileName: `${mediaId(hex)}.png`,
  buffer: Buffer.from(PNG),
  mimeType: 'image/png',
  mediaType: 'IMAGE',
});

const storedVideo = (hex: string): StoredCreativeSourceMediaFile => ({
  fileName: `${mediaId(hex)}.mp4`,
  buffer: Buffer.from(MP4),
  mimeType: 'video/mp4',
  mediaType: 'VIDEO',
});

const storageWith = (storedById: Record<string, StoredCreativeSourceMediaFile>) =>
  ({
    readMediaById: vi.fn(async (id: string) => storedById[id] || null),
  }) as unknown as MediaStorage;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('server-side creative source hydration', () => {
  it('hydrates every source in order from authoritative stored metadata', async () => {
    const videoId = mediaId('a');
    const imageId = mediaId('b');
    const storage = storageWith({
      [videoId]: storedVideo('a'),
      [imageId]: storedImage('b'),
    });

    const result = await hydrateCreativeSourceSelections(storage, [
      { mediaId: videoId, role: 'TRA_VIDEO' },
      { mediaId: imageId, role: 'TRA_REFERENCE' },
    ]);

    expect(result.map(({ stored: _stored, ...source }) => source)).toEqual([
      {
        role: 'TRA_VIDEO',
        media: {
          id: videoId,
          fileName: `${videoId}.mp4`,
          mimeType: 'video/mp4',
          mediaType: 'VIDEO',
          size: MP4.byteLength,
          url: `/api/media/files/${videoId}.mp4`,
        },
      },
      {
        role: 'TRA_REFERENCE',
        media: {
          id: imageId,
          fileName: `${imageId}.png`,
          mimeType: 'image/png',
          mediaType: 'IMAGE',
          size: PNG.byteLength,
          url: `/api/media/files/${imageId}.png`,
        },
      },
    ]);
    expect(storage.readMediaById).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['TRA_VIDEO', storedImage('c')],
    ['TRA_REFERENCE', storedVideo('c')],
    ['LAYOUT_REFERENCE', storedVideo('c')],
  ] as const)('rejects %s when stored media has an incompatible type', async (role, stored) => {
    const id = mediaId('c');

    await expect(
      hydrateCreativeSourceSelections(storageWith({ [id]: stored }), [
        { mediaId: id, role },
      ])
    ).rejects.toMatchObject({
      name: 'CreativeSourceHydrationError',
      status: 400,
    });
  });

  it('rejects missing stored media', async () => {
    await expect(
      hydrateCreativeSourceSelections(storageWith({}), [
        { mediaId: mediaId('d'), role: 'TRA_REFERENCE' },
      ])
    ).rejects.toEqual(
      expect.objectContaining<Partial<CreativeSourceHydrationError>>({
        status: 404,
      })
    );
  });

  it('revalidates malformed stored bytes before later use', async () => {
    const id = mediaId('e');
    const malformed = {
      ...storedImage('e'),
      buffer: Buffer.from('not an image'),
    };

    await expect(
      hydrateCreativeSourceSelections(storageWith({ [id]: malformed }), [
        { mediaId: id, role: 'TRA_REFERENCE' },
      ])
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rechecks the configured size limit against actual stored bytes', async () => {
    const id = mediaId('f');
    vi.stubEnv('MAX_UPLOAD_BYTES', String(PNG.length - 1));

    await expect(
      hydrateCreativeSourceSelections(storageWith({ [id]: storedImage('f') }), [
        { mediaId: id, role: 'TRA_REFERENCE' },
      ])
    ).rejects.toMatchObject({ status: 400 });
  });

  it('selects only the first validated TRA reference image for provider pixels', async () => {
    const layoutId = mediaId('1');
    const videoId = mediaId('2');
    const traId = mediaId('3');
    const secondTraId = mediaId('4');
    const sources = await hydrateCreativeSourceSelections(
      storageWith({
        [layoutId]: storedImage('1'),
        [videoId]: storedVideo('2'),
        [traId]: storedImage('3'),
        [secondTraId]: storedImage('4'),
      }),
      [
        { mediaId: layoutId, role: 'LAYOUT_REFERENCE' },
        { mediaId: videoId, role: 'TRA_VIDEO' },
        { mediaId: traId, role: 'TRA_REFERENCE' },
        { mediaId: secondTraId, role: 'TRA_REFERENCE' },
      ]
    );

    const eligible = findEligibleProviderImageSource(sources);
    expect(eligible?.media.id).toBe(traId);
    expect(eligible?.stored.buffer).toEqual(PNG);
  });
});
