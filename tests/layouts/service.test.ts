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

describe.each(['local', 'r2'])('semantic cache in existing %s backend', backend => {
  it('isolates semantic identity, handles corrupt metadata, and preserves blueprint objects', async () => {
    const { mkdtemp, readFile, writeFile, readdir, rm } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const dir = await mkdtemp(join(tmpdir(), 'a31-cache-'));
    const objects = new Map<string, string>();
    const spy = vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: any) => {
      const key = command.input.Key;
      if (command instanceof GetObjectCommand) {
        if (!objects.has(key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => objects.get(key)! } };
      }
      objects.set(key, command.input.Body);
      return {};
    }) as any);
    vi.stubEnv('NODE_ENV', backend === 'r2' ? 'production' : 'test');
    vi.stubEnv('LAYOUT_BLUEPRINT_CACHE_DIR', dir);
    for (const name of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) vi.stubEnv(name, 'test');
    vi.resetModules();
    try {
      const { getLayoutBlueprintCache, getOrAnalyzeLayoutBlueprint: resolveBlueprint } = await import('@/lib/layouts/service');
      const cache = getLayoutBlueprintCache();
      const hash = createHash('sha256').update(source().buffer).digest('hex');
      const angle = { version: 1 as const, sourceSha256: hash, analyzerModel: 'semantic-model', angleSummary: 'A clear next step.' };
      const keys = async () => backend === 'r2' ? [...objects.keys()] : readdir(dir);
      const read = async (key: string) => backend === 'r2' ? objects.get(key)! : readFile(join(dir, key), 'utf8');
      const write = async (key: string, raw: string) => {
        if (backend === 'r2') objects.set(key, raw); else await writeFile(join(dir, key), raw);
      };
      await cache.write(hash, 'layout-model', blueprint());
      const blueprintKey = (await keys())[0];
      const original = JSON.stringify({ ...JSON.parse(await read(blueprintKey)), unrelated: { keep: true } });
      await write(blueprintKey, original);
      expect(await cache.readAngle(hash, angle.analyzerModel)).toBeNull();
      await cache.writeAngle(angle);
      expect(await cache.readAngle(hash, angle.analyzerModel)).toEqual(angle);
      expect(await cache.readAngle(hash, angle.analyzerModel)).toEqual(angle);
      expect(await cache.readAngle('b'.repeat(64), angle.analyzerModel)).toBeNull();
      expect(await cache.readAngle(hash, 'new-model')).toBeNull();
      const angleKey = (await keys()).find(key => key.includes('angle-v1-'))!;
      for (const corrupt of ['{', 'null', JSON.stringify({ ...angle, version: 2 }),
        JSON.stringify({ ...angle, sourceSha256: 'b'.repeat(64) }), JSON.stringify({ ...angle, analyzerModel: 'other' }),
        JSON.stringify({ ...angle, angleSummary: '' })]) {
        await write(angleKey, corrupt);
        expect(await cache.readAngle(hash, angle.analyzerModel)).toBeNull();
      }
      await write(angleKey.replace('angle-v1-', 'angle-v2-'), JSON.stringify(angle));
      expect(await cache.readAngle(hash, angle.analyzerModel)).toBeNull();
      await expect(cache.writeAngle({ ...angle, angleSummary: '' })).rejects.toThrow('Invalid');
      await cache.writeAngle(angle);
      const analyze = vi.fn();
      expect((await resolveBlueprint(source(), { cache, analyzerModel: 'layout-model', analyze })).cacheHit).toBe(true);
      expect(analyze).not.toHaveBeenCalled();
      expect(await read(blueprintKey)).toBe(original);
      const angleRaw = await read(angleKey);
      await cache.write(hash, 'other-layout-model', blueprint());
      expect(await read(angleKey)).toBe(angleRaw);
      expect(await read(blueprintKey)).toBe(original);
    } finally {
      spy.mockRestore();
      vi.unstubAllEnvs();
      vi.resetModules();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
