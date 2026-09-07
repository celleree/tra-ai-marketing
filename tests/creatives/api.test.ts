import { describe, expect, it, vi } from 'vitest';

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

describe('TRA creatives API validation', () => {
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
