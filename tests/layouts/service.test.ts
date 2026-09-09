import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  getOrAnalyzeLayoutBlueprint,
  type LayoutBlueprintCache,
} from '@/lib/layouts/service';
import type { LayoutBlueprint } from '@/lib/layouts/blueprint';
import type { StoredMediaFile } from '@/lib/media/types';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const source = (suffix = 0): StoredMediaFile => ({
  fileName: `media_${'a'.repeat(31)}${suffix}.png`,
  buffer: suffix ? Buffer.concat([PNG, Buffer.from([suffix])]) : Buffer.from(PNG),
  mimeType: 'image/png',
});

const blueprint = (): LayoutBlueprint => ({
  version: 1,
  composition: {
    flow: 'CENTERED_STACK',
    balance: 'CENTER_WEIGHTED',
    imageTextBalance: 'TEXT_HEAVY',
  },
  regions: [
    {
      role: 'HEADLINE',
      xPct: 10,
      yPct: 12,
      widthPct: 80,
      heightPct: 24,
      alignment: 'CENTER',
      emphasis: 'PRIMARY',
      crop: 'NONE',
      overlapsOtherRegions: false,
    },
  ],
  whitespace: 'SPARSE',
  textDensity: 'SPARSE',
  ctaTreatment: 'PILL',
  backgroundMechanisms: ['SOLID_COLOR'],
  imageTreatments: ['NONE'],
  typography: {
    headlineScale: 'EXTRA_LARGE',
    headlineWeight: 'BOLD',
    headlineAlignment: 'CENTER',
    hierarchyLevels: 2,
    contrast: 'HIGH',
  },
  spacing: {
    outerMargin: 'GENEROUS',
    regionGap: 'MODERATE',
    alignmentGrid: 'CENTER_AXIS',
  },
  reusableMechanisms: ['STRONG_SINGLE_COLUMN'],
  restrictedElementsPresent: {
    humanIdentity: false,
    thirdPartyLogoOrBranding: true,
    exactCopy: true,
    trademark: false,
    claimOrProof: false,
  },
});

const memoryCache = (): LayoutBlueprintCache => {
  const values = new Map<string, LayoutBlueprint>();
  return {
    read: vi.fn(async (hash: string, model: string) => values.get(`${model}:${hash}`) || null),
    write: vi.fn(async (hash: string, model: string, value: LayoutBlueprint) => {
      values.set(`${model}:${hash}`, value);
    }),
  };
};

describe('layout blueprint analysis cache', () => {
  it('analyzes unchanged pixels once and reuses the validated cached blueprint', async () => {
    const cache = memoryCache();
    const analyze = vi.fn(async () => blueprint());
    const stored = source();

    const first = await getOrAnalyzeLayoutBlueprint(stored, {
      cache,
      analyze,
      analyzerModel: 'layout-model',
    });
    const second = await getOrAnalyzeLayoutBlueprint(stored, {
      cache,
      analyze,
      analyzerModel: 'layout-model',
    });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(cache.write).toHaveBeenCalledTimes(1);
    expect(first.contentHash).toBe(createHash('sha256').update(stored.buffer).digest('hex'));
    expect(second.blueprint).toEqual(first.blueprint);
  });

  it('reanalyzes when the reference pixels change', async () => {
    const cache = memoryCache();
    const analyze = vi.fn(async () => blueprint());

    const first = await getOrAnalyzeLayoutBlueprint(source(), {
      cache,
      analyze,
      analyzerModel: 'layout-model',
    });
    const changed = await getOrAnalyzeLayoutBlueprint(source(1), {
      cache,
      analyze,
      analyzerModel: 'layout-model',
    });

    expect(first.contentHash).not.toBe(changed.contentHash);
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it('reanalyzes when the analyzer model changes even if pixels do not', async () => {
    const cache = memoryCache();
    const analyze = vi.fn(async () => blueprint());
    const stored = source();

    await getOrAnalyzeLayoutBlueprint(stored, {
      cache,
      analyze,
      analyzerModel: 'layout-model-a',
    });
    const second = await getOrAnalyzeLayoutBlueprint(stored, {
      cache,
      analyze,
      analyzerModel: 'layout-model-b',
    });

    expect(second.cacheHit).toBe(false);
    expect(analyze).toHaveBeenCalledTimes(2);
  });
});
