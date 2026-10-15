import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreativeRecord } from '@/lib/creatives/generated';
import {
  parseCreativeCopyContract,
  resolveCreativeAdCopy,
} from '@/lib/creatives/copy-contract';

const { mkdirMock, readFileMock, writeFileMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  mkdir: mkdirMock,
  readFile: readFileMock,
  writeFile: writeFileMock,
}));

import { listCreatives, saveCreativeBatch } from '@/lib/creatives/storage';

const copy = {
  primaryText: 'Primary text',
  headline: 'Headline',
  description: 'Description',
};
const imageCopy = { headline: 'Image headline', cta: 'Learn more' };
const overlong = 'x'.repeat(1001);
const optionalImageCopyFields = [
  'shortSupport',
  'proofAttribution',
  'cta',
  'disclosure',
] as const;
const modernE2 = () => ({
  copy: { ...copy },
  adCopy: { ...copy },
  imageCopy: { ...imageCopy },
});
const expectInvalid = (value: Record<string, unknown>) =>
  expect(parseCreativeCopyContract(value)).toBeNull();

const record = (hex: string): CreativeRecord => ({
  id: `creative_${hex.repeat(32)}`,
  createdAt: '2026-09-14T20:00:00.000Z',
  image: {
    id: `media_${hex.repeat(32)}`,
    fileName: `media_${hex.repeat(32)}.png`,
    originalName: 'creative.png',
    mimeType: 'image/png',
    size: 128,
    url: `/api/media/files/media_${hex.repeat(32)}.png`,
  },
  category: 'customer-problems',
  copy,
});

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  mkdirMock.mockReset().mockResolvedValue(undefined);
  readFileMock.mockReset();
  writeFileMock.mockReset().mockResolvedValue(undefined);
});

describe('creative copy contract', () => {
  it('preserves legacy copy-only compatibility without inventing separated copy', () => {
    const legacy = {
      primaryText: 'Primary text',
      headline: 'Headline',
      description: overlong,
      historicalExtra: 'legacy-only metadata',
    };
    const parsed = parseCreativeCopyContract({ copy: legacy });
    expect(parsed).toEqual({ copy: {
      primaryText: legacy.primaryText,
      headline: legacy.headline,
      description: legacy.description,
    } });
    expect(parsed?.imageCopy).toBeUndefined();
    expect(resolveCreativeAdCopy(parsed!)).toEqual(parsed!.copy);
  });

  it('accepts valid E2 separated copy', () => {
    const value = modernE2();
    expect(parseCreativeCopyContract(value)).toEqual(value);
  });

  it.each([
    ['primaryText', ''],
    ['primaryText', '   '],
    ['headline', ''],
    ['headline', '   '],
  ] as const)('rejects blank/whitespace modern %s=%j', (field, value) => {
    const modern = modernE2();
    modern.copy[field] = value;
    modern.adCopy[field] = value;
    expectInvalid(modern);
  });

  it.each(['', '   '] as const)('rejects blank/whitespace imageCopy headline=%j', value => {
    const modern = modernE2();
    modern.imageCopy.headline = value;
    expectInvalid(modern);
  });

  it('rejects whitespace-only optional imageCopy fields', () => {
    for (const field of optionalImageCopyFields) {
      const modern = modernE2();
      (modern.imageCopy as Record<string, unknown>)[field] = '   ';
      expectInvalid(modern);
    }
  });

  it('rejects overlong modern copy/adCopy fields', () => {
    for (const field of ['primaryText', 'headline', 'description'] as const) {
      const modern = modernE2();
      modern.copy[field] = overlong;
      modern.adCopy[field] = overlong;
      expectInvalid(modern);
    }
  });

  it('rejects overlong imageCopy headline and optional fields', () => {
    const headline = modernE2();
    headline.imageCopy.headline = overlong;
    expectInvalid(headline);
    for (const field of optionalImageCopyFields) {
      const modern = modernE2();
      (modern.imageCopy as Record<string, unknown>)[field] = overlong;
      expectInvalid(modern);
    }
  });

  it.each([
    ['Review proofAttribution', 'proofAttribution'],
    ['Case Study disclosure', 'disclosure'],
  ] as const)('keeps the %s field within the canonical 1,000-character limit', (_label, field) => {
    const accepted = modernE2();
    (accepted.imageCopy as Record<string, unknown>)[field] = 'x'.repeat(1000);
    expect(parseCreativeCopyContract(accepted)).not.toBeNull();

    const rejected = modernE2();
    (rejected.imageCopy as Record<string, unknown>)[field] = overlong;
    expectInvalid(rejected);
  });

  it('rejects unexpected keys in copy, adCopy, and imageCopy', () => {
    for (const field of ['copy', 'adCopy', 'imageCopy'] as const) {
      const modern = modernE2();
      (modern[field] as Record<string, unknown>).unexpected = 'not allowed';
      expectInvalid(modern);
    }
  });

  it('fails closed when copy and ad copy disagree', () => {
    const modern = modernE2();
    modern.adCopy.headline = 'Different headline';
    expectInvalid(modern);
  });

  it.each([
    { adCopy: { ...copy, description: 42 } },
    { imageCopy: { headline: 42 } },
    { imageCopy: { headline: 'Headline', shortSupport: false } },
    { imageCopy: { headline: 'Headline', proofAttribution: 42 } },
    { imageCopy: { headline: 'Headline', cta: [] } },
    { imageCopy: { headline: 'Headline', disclosure: {} } },
  ])('rejects partial or malformed supplied copy metadata %#', extra => {
    expect(parseCreativeCopyContract({ copy, ...extra })).toBeNull();
  });

  it('round-trips explicit ad and image copy through persistence', async () => {
    const incoming = {
      ...record('b'),
      adCopy: { ...copy },
      imageCopy: {
        headline: 'Image headline',
        shortSupport: 'Short support',
        cta: 'Learn more',
      },
    };
    readFileMock.mockResolvedValueOnce(JSON.stringify({ version: 1, items: [] }));
    await saveCreativeBatch([incoming]);

    const encoded = writeFileMock.mock.calls[0][1] as string;
    readFileMock.mockResolvedValueOnce(encoded);
    const [saved] = await listCreatives();
    expect(saved.adCopy).toEqual(copy);
    expect(saved.imageCopy).toEqual(incoming.imageCopy);
    expect(saved.copy).toEqual(copy);
  });

  it('round-trips a legacy copy-only record without manufacturing image copy', async () => {
    const legacy = record('a');
    const incoming = record('b');
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({ version: 1, items: [legacy] })
    );
    await saveCreativeBatch([incoming]);

    const encoded = writeFileMock.mock.calls[0][1] as string;
    const persistedLegacy = JSON.parse(encoded).items[1];
    expect(persistedLegacy.copy).toEqual(copy);
    expect(persistedLegacy.adCopy).toBeUndefined();
    expect(persistedLegacy.imageCopy).toBeUndefined();

    readFileMock.mockResolvedValueOnce(encoded);
    const savedLegacy = (await listCreatives()).find((item) => item.id === legacy.id)!;
    expect(savedLegacy.copy).toEqual(copy);
    expect(savedLegacy.adCopy).toBeUndefined();
    expect(savedLegacy.imageCopy).toBeUndefined();
  });

  it('rejects malformed serialized E2 data before it can become a revision parent', async () => {
    const malformed = {
      ...record('a'),
      copy: { ...copy, unexpected: 'must not be discarded' },
      adCopy: { ...copy },
      imageCopy: { headline: 'Image headline' },
    };
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({ version: 1, items: [malformed] })
    );
    await expect(listCreatives()).rejects.toThrow(
      'Creative library index contains an invalid record.'
    );
  });

  it('rejects mismatched or malformed copy metadata before persistence', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({ version: 1, items: [] }));
    await expect(saveCreativeBatch([{
      ...record('b'),
      adCopy: { ...copy, headline: 'Mismatch' },
    }])).rejects.toThrow('One or more creative records are invalid.');
    await expect(saveCreativeBatch([{
      ...record('c'),
      imageCopy: { headline: 'Headline', cta: 42 },
    } as unknown as CreativeRecord])).rejects.toThrow(
      'One or more creative records are invalid.'
    );
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});
