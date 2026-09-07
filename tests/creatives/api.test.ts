import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { CreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';

const { getMediaStorageMock, saveCreativeBatchMock } = vi.hoisted(() => ({
  getMediaStorageMock: vi.fn(),
  saveCreativeBatchMock: vi.fn(),
}));

vi.mock('@/lib/creatives/storage', () => ({
  isSafeCreativeId: (value: string) => /^creative_[a-f0-9]{32}$/.test(value),
  listCreatives: vi.fn(),
  saveCreativeBatch: saveCreativeBatchMock,
}));

vi.mock('@/lib/creatives/attribution', () => ({
  getCreativeAttribution: vi.fn(),
}));

vi.mock('@/lib/media/local-storage', () => ({
  getMediaStorage: getMediaStorageMock,
}));

import { POST } from '@/app/api/creatives/route';

const request = (body: string) =>
  new Request('http://localhost/api/creatives', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

const creative = {
  id: `creative_${'a'.repeat(32)}`,
  image: { id: `media_${'b'.repeat(32)}`, fileName: `media_${'b'.repeat(32)}.png`, originalName: 'creative.png', mimeType: 'image/png', size: 128 },
  category: 'customer-problems',
  copy: { primaryText: 'Primary text', headline: 'Headline', description: 'Description' },
};

const planning = {
  strategy: {
    category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Busy taxpayer', painPoint: 'Growing notices', desiredOutcome: 'A clear resolution path', emotion: 'Relief', hook: 'Open the letter with confidence', cta: 'Get a consultation', offer: null,
    soWhat: { surfaceMessage: 'We help organize your tax case', functionalConsequence: 'You understand the next step', meaningfulOutcome: 'You can move forward with confidence' },
    execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'photographic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' }, visualDirection: 'A clean desk and organized documents',
  }, selectionReason: 'Distinct strategic fit', model: 'planner-model', reasoningEffort: 'medium',
};

const generationProvenance: CreativeGenerationProvenance = {
  version: 1,
  revision: { parentCreativeId: `creative_${'f'.repeat(32)}`, canvasMediaId: `media_${'a'.repeat(32)}`, canvasSha256: 'a'.repeat(64), instruction: 'Improve headline contrast.' },
  imageGeneration: { prompt: '  Exact provider prompt\nwith retained whitespace  ', model: 'gpt-image-2' },
  requestedSources: [{ role: 'TRA_REFERENCE', mediaId: `media_${'c'.repeat(32)}`, sha256: 'd'.repeat(64) }],
  attachedSource: { type: 'TRA_REFERENCE_IMAGE', mediaId: `media_${'c'.repeat(32)}`, sha256: 'd'.repeat(64) },
  analysisSources: [{ type: 'REFERENCE_LIBRARY', mediaId: `media_${'e'.repeat(32)}` }],
  logoOverlaySource: { mediaId: `media_${'f'.repeat(32)}`, sha256: 'a'.repeat(64) },
};

const identity = {
  conceptId: creative.id,
  parentCreativeId: null,
  operation: 'GENERATE' as const,
  fingerprint: 'a'.repeat(64),
};

beforeEach(() => {
  getMediaStorageMock.mockReset();
  saveCreativeBatchMock.mockReset();
});

describe('TRA creatives API validation', () => {
  it('retains full provenance and rejects malformed supplied provenance before saving', async () => {
    getMediaStorageMock.mockReturnValue({ readImageById: vi.fn().mockResolvedValue(creative.image) });
    saveCreativeBatchMock.mockImplementation(async (records) => records);
    const response = await POST(request(JSON.stringify({ creatives: [{ ...creative, generationProvenance }] })));
    expect(response.status).toBe(201);
    expect(saveCreativeBatchMock).toHaveBeenCalledWith([expect.objectContaining({ generationProvenance })]);
    saveCreativeBatchMock.mockClear();
    for (const invalid of [null, { ...generationProvenance, version: 2 }]) {
      expect((await POST(request(JSON.stringify({ creatives: [{ ...creative, generationProvenance: invalid }] })))).status).toBe(400);
    }
    expect(saveCreativeBatchMock).not.toHaveBeenCalled();
  });

  it('retains a valid identity and rejects malformed supplied identity', async () => {
    getMediaStorageMock.mockReturnValue({ readImageById: vi.fn().mockResolvedValue(creative.image) });
    saveCreativeBatchMock.mockImplementation(async (records) => records);
    expect((await POST(request(JSON.stringify({ creatives: [{ ...creative, identity }] })))).status).toBe(201);
    expect(saveCreativeBatchMock).toHaveBeenCalledWith([expect.objectContaining({ identity })]);
    saveCreativeBatchMock.mockClear();
    expect((await POST(request(JSON.stringify({ creatives: [{ ...creative, identity: { ...identity, fingerprint: 'A'.repeat(64) } }] })))).status).toBe(400);
    expect(saveCreativeBatchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"invalid"'],
    ['a missing creatives property', '{}'],
    ['a non-array creatives property', '{"creatives":null}'],
  ])('returns 400 for %s', async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(saveCreativeBatchMock).not.toHaveBeenCalled();
    expect(getMediaStorageMock).not.toHaveBeenCalled();
  });

  it('retains valid generated planning, format, and placement', async () => {
    getMediaStorageMock.mockReturnValue({ readImageById: vi.fn().mockResolvedValue(creative.image) });
    saveCreativeBatchMock.mockImplementation(async (records) => records);
    const response = await POST(request(JSON.stringify({ creatives: [{ ...creative, format: 'direct-response', placement: 'PORTRAIT_4_5', planning }] })));
    expect(response.status).toBe(201);
    expect(saveCreativeBatchMock).toHaveBeenCalledWith([expect.objectContaining({ format: 'direct-response', placement: 'PORTRAIT_4_5', planning })]);
  });

  it('defaults an omitted source to generated and retains uploaded source', async () => {
    const upload = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#123047' } }).png().toBuffer();
    getMediaStorageMock.mockReturnValue({ readImageById: vi.fn().mockResolvedValue({ ...creative.image, buffer: upload }) });
    saveCreativeBatchMock.mockImplementation(async (records) => records);

    expect((await POST(request(JSON.stringify({ creatives: [creative] })))).status).toBe(201);
    expect(saveCreativeBatchMock).toHaveBeenLastCalledWith([
      expect.objectContaining({ source: 'generated' }),
    ]);

    expect((await POST(request(JSON.stringify({ creatives: [{ ...creative, source: 'uploaded' }] })))).status).toBe(201);
    expect(saveCreativeBatchMock).toHaveBeenLastCalledWith([
      expect.objectContaining({ source: 'uploaded', placement: 'SQUARE_1_1' }),
    ]);

    expect((await POST(request(JSON.stringify({ creatives: [{ ...creative, source: 'manual' }] })))).status).toBe(400);
  });

  it('derives uploaded placements from stored display dimensions and omits unsupported ratios', async () => {
    const rotated = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#123047' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    getMediaStorageMock.mockReturnValue({ readImageById: vi.fn().mockResolvedValue({ ...creative.image, fileName: creative.image.fileName.replace('.png', '.jpg'), mimeType: 'image/jpeg', buffer: rotated }) });
    saveCreativeBatchMock.mockImplementation(async (records) => records);
    const uploaded = { ...creative, image: { ...creative.image, fileName: creative.image.fileName.replace('.png', '.jpg'), mimeType: 'image/jpeg' }, source: 'uploaded', placement: 'LANDSCAPE_16_9' };

    expect((await POST(request(JSON.stringify({ creatives: [uploaded] })))).status).toBe(201);
    expect(saveCreativeBatchMock).toHaveBeenLastCalledWith([
      expect.objectContaining({ source: 'uploaded', placement: 'VERTICAL_9_16' }),
    ]);

    const unsupported = await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#123047' } }).jpeg().toBuffer();
    getMediaStorageMock.mockReturnValue({ readImageById: vi.fn().mockResolvedValue({ ...uploaded.image, buffer: unsupported }) });
    expect((await POST(request(JSON.stringify({ creatives: [uploaded] })))).status).toBe(201);
    expect(saveCreativeBatchMock).toHaveBeenLastCalledWith([
      expect.not.objectContaining({ placement: expect.anything() }),
    ]);
  });

  it('rejects an unreadable stored upload instead of assigning a placement', async () => {
    getMediaStorageMock.mockReturnValue({ readImageById: vi.fn().mockResolvedValue({ ...creative.image, buffer: Buffer.from('not-an-image') }) });
    const response = await POST(request(JSON.stringify({ creatives: [{ ...creative, source: 'uploaded' }] })));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'One or more uploaded creative images could not be read.' });
    expect(saveCreativeBatchMock).not.toHaveBeenCalled();
  });

  it('accepts legacy records without generated metadata and rejects malformed supplied metadata', async () => {
    getMediaStorageMock.mockReturnValue({ readImageById: vi.fn().mockResolvedValue(creative.image) });
    saveCreativeBatchMock.mockImplementation(async (records) => records);
    expect((await POST(request(JSON.stringify({ creatives: [creative] })))).status).toBe(201);
    expect(saveCreativeBatchMock).toHaveBeenLastCalledWith([expect.not.objectContaining({ format: expect.anything(), placement: expect.anything(), planning: expect.anything() })]);
    for (const invalid of [{ ...creative, format: 'unsupported' }, { ...creative, placement: 'LANDSCAPE_16_9' }, { ...creative, planning: { ...planning, reasoningEffort: 'high' } }]) {
      expect((await POST(request(JSON.stringify({ creatives: [invalid] })))).status).toBe(400);
    }
  });
});
