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
  it('resolves legacy copy as ad copy without inventing image copy', () => {
    const parsed = parseCreativeCopyContract({ copy });
    expect(parsed).toEqual({ copy });
    expect(parsed?.imageCopy).toBeUndefined();
    expect(resolveCreativeAdCopy(parsed!)).toEqual(copy);
  });

  it('accepts matching explicit ad copy and complete or partial image copy', () => {
    const imageCopy = {
      headline: 'Image headline',
      shortSupport: 'Short support',
      proofAttribution: 'Approved source attribution',
      cta: 'Learn more',
      disclosure: 'Applicable disclosure',
    };
    const parsed = parseCreativeCopyContract({ copy, adCopy: copy, imageCopy });
    expect(parsed).toEqual({ copy, adCopy: copy, imageCopy });
    expect(parseCreativeCopyContract({
      copy,
      imageCopy: { headline: 'Image headline' },
    })?.imageCopy).toEqual({ headline: 'Image headline' });
  });

  it('fails closed when copy and ad copy disagree', () => {
    expect(parseCreativeCopyContract({
      copy,
      adCopy: { ...copy, headline: 'Different headline' },
    })).toBeNull();
  });

  it.each([
    { adCopy: { ...copy, description: 42 } },
    { imageCopy: { headline: 42 } },
    { imageCopy: { headline: 'Headline', shortSupport: false } },
    { imageCopy: { headline: 'Headline', proofAttribution: 42 } },
    { imageCopy: { headline: 'Headline', cta: [] } },
    { imageCopy: { headline: 'Headline', disclosure: {} } },
  ])('rejects malformed supplied copy metadata %#', (extra) => {
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
