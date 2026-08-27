import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getStoredMediaMimeType,
  getStoredImageMimeType,
  isSupportedMp4Container,
  isSafeMediaId,
  MediaValidationError,
  prepareMedia,
  prepareMediaImage,
} from '@/lib/media/storage';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const WEBP_SIGNATURE = [
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
];
const isoBox = (type: string, payload = Buffer.alloc(0)) => {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'ascii');
  payload.copy(box, 8);
  return box;
};

const makeMp4 = (
  majorBrand = 'isom',
  compatibleBrands = ['isom', 'mp42'],
  mediaBoxes = [isoBox('moov'), isoBox('mdat', Buffer.from([0x00]))]
) => {
  const brandPayload = Buffer.alloc(8 + compatibleBrands.length * 4);
  brandPayload.write(majorBrand, 0, 4, 'ascii');
  brandPayload.writeUInt32BE(0x200, 4);
  compatibleBrands.forEach((brand, index) =>
    brandPayload.write(brand, 8 + index * 4, 4, 'ascii')
  );
  return Buffer.concat([isoBox('ftyp', brandPayload), ...mediaBoxes]);
};

const MP4_SIGNATURE = Array.from(makeMp4());

const makeFile = (
  bytes: readonly number[],
  type: string,
  name = 'upload'
): File => {
  const data = Uint8Array.from(bytes);
  return {
    name,
    type,
    size: data.byteLength,
    arrayBuffer: async () => data.buffer.slice(0),
  } as unknown as File;
};

describe('media validation contract', () => {
  beforeEach(() => {
    vi.stubEnv('CREATIVE_PUBLIC_BASE_URL', '');
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      label: 'PNG',
      bytes: PNG_SIGNATURE,
      mimeType: 'image/png' as const,
      extension: 'png',
    },
    {
      label: 'JPEG',
      bytes: JPEG_SIGNATURE,
      mimeType: 'image/jpeg' as const,
      extension: 'jpg',
    },
    {
      label: 'WebP',
      bytes: WEBP_SIGNATURE,
      mimeType: 'image/webp' as const,
      extension: 'webp',
    },
  ])(
    'accepts a matching $label signature and returns a canonical asset',
    async ({ bytes, mimeType, extension }) => {
      const prepared = await prepareMediaImage(
        makeFile(bytes, mimeType, `creative.${extension}`)
      );

      expect(prepared.id).toMatch(/^media_[a-f0-9]{32}$/);
      expect(prepared.fileName).toBe(`${prepared.id}.${extension}`);
      expect(prepared.originalName).toBe(`creative.${extension}`);
      expect(prepared.mimeType).toBe(mimeType);
      expect(prepared.size).toBe(bytes.length);
      expect(prepared.url).toBe(`/api/media/files/${prepared.fileName}`);
      expect(prepared.buffer).toEqual(Buffer.from(bytes));
      expect(isSafeMediaId(prepared.id)).toBe(true);
      expect(getStoredImageMimeType(prepared.fileName)).toBe(mimeType);
    }
  );

  it('accepts a matching MP4 signature as video media', async () => {
    const prepared = await prepareMedia(
      makeFile(MP4_SIGNATURE, 'video/mp4', 'approved-tra-video.mp4')
    );

    expect(prepared.id).toMatch(/^media_[a-f0-9]{32}$/);
    expect(prepared.fileName).toBe(`${prepared.id}.mp4`);
    expect(prepared.originalName).toBe('approved-tra-video.mp4');
    expect(prepared.mimeType).toBe('video/mp4');
    expect(prepared.mediaType).toBe('VIDEO');
    expect(prepared.buffer).toEqual(Buffer.from(MP4_SIGNATURE));
    expect(getStoredMediaMimeType(prepared.fileName)).toBe('video/mp4');
    expect(getStoredImageMimeType(prepared.fileName)).toBeNull();
  });

  it.each([
    ['truncated ftyp', Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])],
    [
      'out-of-bounds ftyp',
      (() => {
        const bytes = makeMp4();
        bytes.writeUInt32BE(bytes.length + 20, 0);
        return bytes;
      })(),
    ],
    ['QuickTime container', makeMp4('qt  ', ['qt  '])],
    ['AVIF container', makeMp4('avif', ['avif', 'mif1'])],
    ['missing movie metadata', makeMp4('isom', ['mp42'], [isoBox('mdat')])],
    ['missing media data', makeMp4('isom', ['mp42'], [isoBox('moov')])],
  ])('rejects an invalid or unsupported MP4: %s', async (_label, bytes) => {
    expect(isSupportedMp4Container(bytes)).toBe(false);
    await expect(
      prepareMedia(makeFile(Array.from(bytes), 'video/mp4', 'source.mp4'))
    ).rejects.toBeInstanceOf(MediaValidationError);
  });

  it('rejects a structurally valid MP4 whose declared MIME is an image', async () => {
    await expect(
      prepareMedia(makeFile(MP4_SIGNATURE, 'image/png', 'source.png'))
    ).rejects.toBeInstanceOf(MediaValidationError);
  });

  it('does not silently accept MP4 as an image', async () => {
    await expect(
      prepareMediaImage(makeFile(MP4_SIGNATURE, 'video/mp4', 'source.mp4'))
    ).rejects.toBeInstanceOf(MediaValidationError);
  });

  it.each([
    {
      label: 'empty',
      file: makeFile([], 'image/png'),
    },
    {
      label: 'unsupported MIME',
      file: makeFile(PNG_SIGNATURE, 'image/gif'),
    },
    {
      label: 'unknown signature',
      file: makeFile([0x00, 0x01, 0x02, 0x03], 'image/png'),
    },
    {
      label: 'MIME/signature mismatch',
      file: makeFile(PNG_SIGNATURE, 'image/jpeg'),
    },
  ])('rejects an $label upload', async ({ file }) => {
    await expect(prepareMediaImage(file)).rejects.toBeInstanceOf(
      MediaValidationError
    );
  });

  it('rejects an upload larger than MAX_UPLOAD_BYTES', async () => {
    vi.stubEnv('MAX_UPLOAD_BYTES', String(PNG_SIGNATURE.length - 1));

    await expect(
      prepareMediaImage(makeFile(PNG_SIGNATURE, 'image/png'))
    ).rejects.toBeInstanceOf(MediaValidationError);
  });

  it('uses a separate MAX_VIDEO_UPLOAD_BYTES limit', async () => {
    vi.stubEnv('MAX_VIDEO_UPLOAD_BYTES', String(MP4_SIGNATURE.length - 1));

    await expect(
      prepareMedia(makeFile(MP4_SIGNATURE, 'video/mp4'))
    ).rejects.toBeInstanceOf(MediaValidationError);
  });

  it('keeps the image upload limit independent from the video limit', async () => {
    vi.stubEnv('MAX_UPLOAD_BYTES', String(PNG_SIGNATURE.length));
    vi.stubEnv('MAX_VIDEO_UPLOAD_BYTES', String(MP4_SIGNATURE.length));

    await expect(
      prepareMediaImage(makeFile(PNG_SIGNATURE, 'image/png'))
    ).resolves.toMatchObject({ mimeType: 'image/png' });
    await expect(
      prepareMedia(makeFile(MP4_SIGNATURE, 'video/mp4'))
    ).resolves.toMatchObject({ mediaType: 'VIDEO' });
  });
});

describe('media identifier and stored-name safety', () => {
  const canonicalId = `media_${'a'.repeat(32)}`;

  it('accepts canonical IDs and stored names', () => {
    expect(isSafeMediaId(canonicalId)).toBe(true);
    expect(getStoredImageMimeType(`${canonicalId}.png`)).toBe('image/png');
    expect(getStoredImageMimeType(`${canonicalId}.jpg`)).toBe('image/jpeg');
    expect(getStoredImageMimeType(`${canonicalId}.webp`)).toBe('image/webp');
    expect(getStoredMediaMimeType(`${canonicalId}.mp4`)).toBe('video/mp4');
    expect(getStoredImageMimeType(`${canonicalId}.mp4`)).toBeNull();
  });

  it.each([
    `media_${'a'.repeat(31)}`,
    `media_${'A'.repeat(32)}`,
    `media_${'g'.repeat(32)}`,
    `${canonicalId}/child`,
    `${canonicalId}\\child`,
    `../${canonicalId}`,
    `..\\${canonicalId}`,
    `${canonicalId}?download=1`,
  ])('rejects noncanonical media ID %s', (mediaId) => {
    expect(isSafeMediaId(mediaId)).toBe(false);
  });

  it.each([
    `../${canonicalId}.png`,
    `..\\${canonicalId}.png`,
    `${canonicalId}/child.png`,
    `${canonicalId}\\child.png`,
    `media_${'A'.repeat(32)}.png`,
    `media_${'g'.repeat(32)}.png`,
    `${canonicalId}.jpeg`,
    `${canonicalId}.png.bak`,
    `${canonicalId}.png?download=1`,
  ])('rejects unsafe or noncanonical stored name %s', (fileName) => {
    expect(getStoredImageMimeType(fileName)).toBeNull();
  });
});
