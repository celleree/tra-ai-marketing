import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredCreativeSourceMediaFile } from '@/lib/media/types';

const mocks = vi.hoisted(() => ({
  analyzeReferenceCreative: vi.fn(),
  analyzeTraSourceCreative: vi.fn(),
  generateApprovedTraReferenceCreativeImage: vi.fn(),
  generateCreativeCopy: vi.fn(),
  getMediaStorage: vi.fn(),
  listReferenceLibrary: vi.fn(),
  selectBestReferenceCreatives: vi.fn(),
}));

vi.mock('@/lib/ai/openai', () => ({
  analyzeReferenceCreative: mocks.analyzeReferenceCreative,
  analyzeTraSourceCreative: mocks.analyzeTraSourceCreative,
  generateApprovedTraReferenceCreativeImage:
    mocks.generateApprovedTraReferenceCreativeImage,
  generateCreativeCopy: mocks.generateCreativeCopy,
}));

vi.mock('@/lib/ai/reference-selector', () => ({
  selectBestReferenceCreatives: mocks.selectBestReferenceCreatives,
}));

vi.mock('@/lib/media/local-storage', () => ({
  getMediaStorage: mocks.getMediaStorage,
}));

vi.mock('@/lib/references/storage', () => ({
  listReferenceLibrary: mocks.listReferenceLibrary,
}));

import { POST } from '@/app/api/creatives/generate/route';

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

const image = (hex: string): StoredCreativeSourceMediaFile => ({
  fileName: `${mediaId(hex)}.png`,
  buffer: Buffer.from(PNG),
  mimeType: 'image/png',
  mediaType: 'IMAGE',
});

const video = (hex: string): StoredCreativeSourceMediaFile => ({
  fileName: `${mediaId(hex)}.mp4`,
  buffer: Buffer.from(MP4),
  mimeType: 'video/mp4',
  mediaType: 'VIDEO',
});

const analysis = {
  summary: 'Source summary',
  visibleText: [],
  visualStructure: 'Simple hierarchy',
  hookOrAngle: 'Tax relief',
  offerOrCta: 'Learn more',
  styleNotes: 'Clear and direct',
  preserve: ['TRA identity'],
  avoid: ['unsupported claims'],
  unknowns: [],
  dominantCategory: 'customer-problems' as const,
};

const libraryItem = (hex: string) => ({
  id: mediaId(hex),
  fileName: `${mediaId(hex)}.png`,
  originalName: `reference-${hex}.png`,
  mimeType: 'image/png' as const,
  size: PNG.length,
  url: `/api/media/files/${mediaId(hex)}.png`,
  addedAt: '2026-01-01T00:00:00.000Z',
  referenceType: 'layout' as const,
  angle: 'customer-problems' as const,
  angleSource: 'manual' as const,
});

const generationRequest = (sourceAssets: Array<{ mediaId: string; role: string }>) =>
  new Request('http://localhost/api/creatives/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceAssets,
      context: 'Create compliant TRA concepts.',
      variationCount: 2,
    }),
  });

let storedById: Record<string, StoredCreativeSourceMediaFile>;
let readMediaById: ReturnType<typeof vi.fn>;
let saveImage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  storedById = {};
  readMediaById = vi.fn(async (id: string) => storedById[id] || null);
  saveImage = vi.fn(async (_file: File) => {
    const id = mediaId(String(saveImage.mock.calls.length));
    return {
      id,
      fileName: `${id}.png`,
      originalName: 'generated.png',
      mimeType: 'image/png' as const,
      size: PNG.length,
      url: `/api/media/files/${id}.png`,
    };
  });
  mocks.getMediaStorage.mockReturnValue({
    readMediaById,
    readImageById: vi.fn(async () => null),
    saveImage,
  });
  mocks.analyzeReferenceCreative.mockResolvedValue(analysis);
  mocks.analyzeTraSourceCreative.mockResolvedValue(analysis);
  mocks.generateCreativeCopy.mockImplementation(async (plan: Array<{ index: number }>) =>
    new Map(
      plan.map((item) => [
        item.index,
        {
          headline: `Headline ${item.index}`,
          primaryText: `Primary ${item.index}`,
          description: `Description ${item.index}`,
        },
      ])
    )
  );
  mocks.generateApprovedTraReferenceCreativeImage.mockResolvedValue(PNG);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('final image-provider source eligibility', () => {
  it('keeps a layout reference analysis-only and uses prompt-only generation', async () => {
    const layoutId = mediaId('a');
    storedById[layoutId] = image('a');

    const response = await POST(
      generationRequest([{ mediaId: layoutId, role: 'LAYOUT_REFERENCE' }])
    );

    expect(response.status).toBe(200);
    expect(mocks.analyzeReferenceCreative).toHaveBeenCalledWith(
      storedById[layoutId],
      'Create compliant TRA concepts.'
    );
    expect(mocks.generateApprovedTraReferenceCreativeImage).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      (fetch as ReturnType<typeof vi.fn>).mock.calls.every(
        ([url]) => url === 'https://api.openai.com/v1/images/generations'
      )
    ).toBe(true);
  });

  it('keeps TRA video out of image-only code and preserves non-human prompt-only generation', async () => {
    const videoId = mediaId('b');
    storedById[videoId] = video('b');

    const response = await POST(
      generationRequest([{ mediaId: videoId, role: 'TRA_VIDEO' }])
    );

    expect(response.status).toBe(200);
    expect(mocks.analyzeReferenceCreative).not.toHaveBeenCalled();
    expect(mocks.analyzeTraSourceCreative).not.toHaveBeenCalled();
    expect(mocks.generateApprovedTraReferenceCreativeImage).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('attaches only the validated TRA reference from mixed sources', async () => {
    const layoutId = mediaId('c');
    const videoId = mediaId('d');
    const traId = mediaId('e');
    storedById = {
      [layoutId]: image('c'),
      [videoId]: video('d'),
      [traId]: image('e'),
    };

    const response = await POST(
      generationRequest([
        { mediaId: layoutId, role: 'LAYOUT_REFERENCE' },
        { mediaId: videoId, role: 'TRA_VIDEO' },
        { mediaId: traId, role: 'TRA_REFERENCE' },
      ])
    );

    expect(response.status).toBe(200);
    expect(readMediaById).toHaveBeenCalledTimes(3);
    expect(mocks.generateApprovedTraReferenceCreativeImage).toHaveBeenCalledTimes(2);
    for (const [call] of mocks.generateApprovedTraReferenceCreativeImage.mock.calls) {
      expect(call.source).toBe(storedById[traId]);
      expect(call.source).not.toBe(storedById[layoutId]);
      expect(call.source.mediaType).toBe('IMAGE');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses external library references only as selection metadata', async () => {
    const traId = mediaId('f');
    const firstReference = libraryItem('1');
    const secondReference = libraryItem('2');
    storedById[traId] = image('f');
    mocks.listReferenceLibrary.mockResolvedValue([
      firstReference,
      secondReference,
    ]);
    mocks.selectBestReferenceCreatives.mockResolvedValue([
      {
        item: firstReference,
        imageUrl: `http://localhost${firstReference.url}`,
        selectionReason: 'Strong hierarchy',
      },
      {
        item: secondReference,
        imageUrl: `http://localhost${secondReference.url}`,
        selectionReason: 'Useful contrast',
      },
    ]);

    const response = await POST(
      generationRequest([{ mediaId: traId, role: 'TRA_REFERENCE' }])
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(readMediaById).toHaveBeenCalledTimes(1);
    expect(readMediaById).toHaveBeenCalledWith(traId);
    expect(mocks.generateApprovedTraReferenceCreativeImage).toHaveBeenCalledTimes(2);
    expect(
      mocks.generateApprovedTraReferenceCreativeImage.mock.calls.every(
        ([call]) => call.source === storedById[traId]
      )
    ).toBe(true);
    expect(payload.referenceLibrarySelections).toHaveLength(2);
  });
});
