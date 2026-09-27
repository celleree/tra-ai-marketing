import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBrandLogoToCreatives } from '@/lib/creatives/brand-logo';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import type { MediaAsset } from '@/lib/media/types';

const mediaId = (hex: string) => `media_${hex.repeat(32)}`;
const generatedFileName = `${mediaId('a')}.png`;
const logoFileName = `${mediaId('b')}.png`;

const uploadedMedia: MediaAsset = {
  id: mediaId('c'),
  fileName: `${mediaId('c')}.png`,
  originalName: 'branded.png',
  mimeType: 'image/png',
  size: 3,
  url: `/api/media/files/${mediaId('c')}.png`,
};

const creative: GeneratedCreative = {
  id: 'creative_1',
  index: 1,
  category: 'customer-problems',
  format: 'native-social',
  image: {
    id: mediaId('a'),
    fileName: generatedFileName,
    originalName: 'generated.png',
    mimeType: 'image/png',
    size: 3,
    url: 'https://production.example.com/api/media/files/old-generated.png',
  },
  copy: { primaryText: 'Primary', headline: 'Headline', description: 'Description' },
};

const imageResponse = () =>
  ({
    ok: true,
    status: 200,
    blob: async () => new Blob(['image'], { type: 'image/png' }),
  }) as Response;

const emptyImageResponse = () =>
  ({
    ok: true,
    status: 200,
    blob: async () => new Blob([], { type: 'image/png' }),
  }) as Response;

const jsonResponse = (payload: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => payload }) as Response;

class FakeCanvasContext {
  drawImage = vi.fn();
  save = vi.fn();
  restore = vi.fn();
  beginPath = vi.fn();
  roundRect = vi.fn();
  fill = vi.fn();
  fillStyle = '';
  imageSmoothingEnabled = false;
  imageSmoothingQuality: ImageSmoothingQuality = 'low';
}

class FakeCanvas {
  width = 0;
  height = 0;
  readonly context = new FakeCanvasContext();

  getContext() {
    return this.context;
  }

  toBlob(callback: BlobCallback) {
    callback(new Blob(['png'], { type: 'image/png' }));
  }
}

let imageDimensions: Array<[number, number]>;
const decode = vi.fn();

class FakeImage {
  decoding: 'auto' | 'async' | 'sync' = 'auto';
  src = '';
  naturalWidth: number;
  naturalHeight: number;

  constructor() {
    const [width, height] = imageDimensions.shift() ?? [1000, 500];
    this.naturalWidth = width;
    this.naturalHeight = height;
  }

  decode() {
    return decode();
  }
}

let canvas: FakeCanvas;
let fetchMock: ReturnType<typeof vi.fn>;
let createObjectUrl: ReturnType<typeof vi.spyOn>;
let revokeObjectUrl: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  imageDimensions = [
    [1024, 1024],
    [1000, 500],
  ];
  decode.mockReset();
  decode.mockResolvedValue(undefined);
  canvas = new FakeCanvas();
  fetchMock = vi.fn();

  vi.stubGlobal('window', { location: { origin: 'https://preview.example.com' } });
  vi.stubGlobal('document', {
    createElement: vi.fn(() => canvas),
  });
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('createImageBitmap', vi.fn());
  createObjectUrl = vi
    .spyOn(URL, 'createObjectURL')
    .mockReturnValueOnce('blob:creative')
    .mockReturnValueOnce('blob:logo');
  revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('applyBrandLogoToCreatives', () => {
  it('does not composite or upload an image already branded by the server', async () => {
    const branded = { ...creative, generationProvenance: { version: 1 as const,
      imageGeneration: { prompt: 'prompt', model: 'gpt-image-2.5-sunburst', routing: { operationType: 'PROMPT_GENERATION' as const,
        preferredModel: 'gpt-image-2.5-sunburst' as const, actualModel: 'gpt-image-2.5-sunburst' as const,
        fallbackUsed: false as const, fallbackFromModel: null, fallbackReason: null } },
      requestedSources: [], attachedSource: null, analysisSources: [],
      logoOverlaySource: { mediaId: mediaId('b'), sha256: 'a'.repeat(64) } } };
    expect(await applyBrandLogoToCreatives([branded], `/api/media/files/${logoFileName}`)).toEqual([branded]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(canvas.context.drawImage).not.toHaveBeenCalled();
  });

  it('uses same-origin media, browser decoding, current panel geometry, and high-quality smoothing', async () => {
    fetchMock
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce(jsonResponse({ direct: false }))
      .mockResolvedValueOnce(jsonResponse(uploadedMedia, true, 201));

    await expect(
      applyBrandLogoToCreatives(
        [creative],
        `https://production.example.com/api/media/files/${logoFileName}`
      )
    ).resolves.toEqual([{ ...creative, image: uploadedMedia }]);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/media/files/${generatedFileName}`,
      `/api/media/files/${logoFileName}`,
      '/api/media/upload-url',
      '/api/media/upload',
    ]);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(canvas.context.roundRect).toHaveBeenCalledWith(31, 31, 202, 111, 12);
    expect(canvas.context.drawImage).toHaveBeenLastCalledWith(
      expect.any(FakeImage),
      45,
      43,
      174,
      87
    );
    expect(canvas.context.imageSmoothingEnabled).toBe(true);
    expect(canvas.context.imageSmoothingQuality).toBe('high');
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:creative');
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:logo');
  });

  it('does not rewrite an external media-like URL that fails the stored-media contract', async () => {
    const externalLogoUrl =
      'https://external.example/api/media/files/not-approved';
    fetchMock
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce(jsonResponse({ direct: false }))
      .mockResolvedValueOnce(jsonResponse(uploadedMedia, true, 201));

    await expect(
      applyBrandLogoToCreatives([creative], externalLogoUrl)
    ).resolves.toEqual([{ ...creative, image: uploadedMedia }]);

    expect(fetchMock.mock.calls.slice(0, 2).map(([url]) => url)).toEqual([
      `/api/media/files/${generatedFileName}`,
      externalLogoUrl,
    ]);
  });

  it('falls back to server upload only when the browser direct PUT rejects', async () => {
    fetchMock
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          direct: true,
          uploadUrl: 'https://r2.example.com/put',
          media: uploadedMedia,
        })
      )
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(uploadedMedia, true, 201));

    await expect(
      applyBrandLogoToCreatives(
        [creative],
        `/api/media/files/${logoFileName}`
      )
    ).resolves.toEqual([{ ...creative, image: uploadedMedia }]);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/media/files/${generatedFileName}`,
      `/api/media/files/${logoFileName}`,
      '/api/media/upload-url',
      'https://r2.example.com/put',
      '/api/media/upload',
    ]);
  });

  it('keeps a non-OK direct PUT as an error and releases decoded images', async () => {
    fetchMock
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          direct: true,
          uploadUrl: 'https://r2.example.com/put',
          media: uploadedMedia,
        })
      )
      .mockResolvedValueOnce({ ok: false, status: 403 } as Response);

    await expect(
      applyBrandLogoToCreatives(
        [creative],
        `/api/media/files/${logoFileName}`
      )
    ).rejects.toThrow('Direct branded creative upload failed.');

    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(
      '/api/media/upload'
    );
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:creative');
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:logo');
  });

  it('surfaces a failed confirmation after a successful direct PUT without uploading again', async () => {
    fetchMock
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          direct: true,
          uploadUrl: 'https://r2.example.com/put',
          media: uploadedMedia,
        })
      )
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
      .mockResolvedValueOnce(
        jsonResponse({ error: 'Confirmation rejected.' }, false, 400)
      );

    await expect(
      applyBrandLogoToCreatives(
        [creative],
        `/api/media/files/${logoFileName}`
      )
    ).rejects.toThrow('Confirmation rejected.');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/media/files/${generatedFileName}`,
      `/api/media/files/${logoFileName}`,
      '/api/media/upload-url',
      'https://r2.example.com/put',
      '/api/media/confirm',
    ]);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/media/upload')).toHaveLength(0);
  });

  it('rejects empty image data before allocating an object URL', async () => {
    fetchMock.mockResolvedValueOnce(emptyImageResponse());

    await expect(
      applyBrandLogoToCreatives(
        [creative],
        `/api/media/files/${logoFileName}`
      )
    ).rejects.toThrow('Generated creative returned an empty image.');

    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it('rejects a dimensionless decoded image and revokes its object URL', async () => {
    imageDimensions = [
      [1024, 1024],
      [0, 0],
    ];
    fetchMock
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce(imageResponse());

    await expect(
      applyBrandLogoToCreatives(
        [creative],
        `/api/media/files/${logoFileName}`
      )
    ).rejects.toThrow('TRA logo has invalid dimensions.');

    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:logo');
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:creative');
  });

  it('surfaces an Image.decode rejection and revokes its allocated object URL', async () => {
    decode.mockRejectedValueOnce(new Error('Decode failed.'));
    fetchMock.mockResolvedValueOnce(imageResponse());

    await expect(
      applyBrandLogoToCreatives(
        [creative],
        `/api/media/files/${logoFileName}`
      )
    ).rejects.toThrow('Generated creative could not be decoded.');

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:creative');
  });
});
