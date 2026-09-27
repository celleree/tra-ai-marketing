import { describe, expect, it } from 'vitest';
import {
  parseCreativeGenerationProvenance,
  type CreativeGenerationProvenance,
} from '@/lib/creatives/generation-provenance';
import type { CreativeRecord, GeneratedCreative } from '@/lib/creatives/generated';

const mediaId = (hex: string) => `media_${hex.repeat(32)}`;
const hash = (hex: string) => hex.repeat(64);
const imageId = mediaId('a');
const videoId = mediaId('b');
const layoutId = mediaId('c');

const provenance = (): CreativeGenerationProvenance => ({
  version: 1,
  imageGeneration: { prompt: '  Preserve this exact prompt.  ', model: 'gpt-image-2' },
  requestedSources: [
    { role: 'TRA_REFERENCE', mediaId: imageId, sha256: hash('a') },
    { role: 'TRA_VIDEO', mediaId: videoId, sha256: hash('b') },
    { role: 'LAYOUT_REFERENCE', mediaId: layoutId, sha256: hash('c') },
  ],
  attachedSource: { type: 'TRA_REFERENCE_IMAGE', mediaId: imageId, sha256: hash('a') },
  analysisSources: [
    { type: 'LAYOUT_REFERENCE', mediaId: layoutId, sha256: hash('c'), layoutCache: { sourceSha256: hash('c'), analyzerModel: 'layout-model', schemaVersion: 1 } },
    { type: 'REFERENCE_LIBRARY', mediaId: mediaId('d') },
  ],
  logoOverlaySource: { mediaId: mediaId('e'), sha256: hash('e') },
});

describe('creative generation provenance', () => {
  it('retains revision canvas identity and instructions separately from human-source provenance', () => {
    const revision = { parentCreativeId: `creative_${'f'.repeat(32)}`, canvasMediaId: mediaId('f'), canvasSha256: hash('f'), instruction: 'Make the headline easier to read.' };
    const parsed = parseCreativeGenerationProvenance({ ...provenance(), revision });
    expect(parsed?.revision).toEqual(revision);
    expect(parsed?.attachedSource).toEqual(provenance().attachedSource);
    expect(parsed?.requestedSources.some((source) => source.mediaId === revision.canvasMediaId)).toBe(false);
    const { instruction: _instruction, ...placementRevision } = revision;
    expect(parseCreativeGenerationProvenance({ ...provenance(), revision: placementRevision })?.revision).toEqual(placementRevision);
    for (const invalid of [null, { ...revision, parentCreativeId: 'invalid' }, { ...revision, canvasMediaId: '../image' }, { ...revision, canvasSha256: 'invalid' }, { ...revision, instruction: ' ' }, { ...revision, instruction: 'x'.repeat(4001) }, { ...revision, approvedHumanSource: true }]) {
      expect(parseCreativeGenerationProvenance({ ...provenance(), revision: invalid })).toBeNull();
    }
    expect(parseCreativeGenerationProvenance(provenance())?.revision).toBeUndefined();
  });

  it('accepts every source union arm and preserves the prompt verbatim', () => {
    const parsed = parseCreativeGenerationProvenance(provenance());
    expect(parsed?.imageGeneration.prompt).toBe('  Preserve this exact prompt.  ');
    expect(parsed?.attachedSource?.type).toBe('TRA_REFERENCE_IMAGE');
    expect(parsed?.analysisSources.map((source) => source.type)).toEqual([
      'LAYOUT_REFERENCE', 'REFERENCE_LIBRARY',
    ]);
    expect(parsed?.logoOverlaySource).toEqual({ mediaId: mediaId('e'), sha256: hash('e') });
  });

  it('stores automatic routing and keeps legacy model-only provenance readable', () => {
    const value = provenance();
    value.imageGeneration.routing = {
      operationType: 'EDIT',
      preferredModel: 'gpt-image-2.5-sunburst',
      actualModel: 'gpt-image-2.5-flare',
      fallbackUsed: true,
      fallbackFromModel: 'gpt-image-2.5-sunburst',
      fallbackReason: 'provider_unavailable',
    };
    value.imageGeneration.model = 'gpt-image-2.5-flare';
    expect(parseCreativeGenerationProvenance(value)?.imageGeneration.routing).toEqual(value.imageGeneration.routing);

    const legacy = provenance();
    expect(parseCreativeGenerationProvenance(legacy)?.imageGeneration).toEqual(legacy.imageGeneration);
  });

  it('rejects inconsistent or unsanitized routing provenance', () => {
    const value = provenance();
    value.imageGeneration.model = 'gpt-image-2.5-flare';
    value.imageGeneration.routing = {
      operationType: 'EDIT',
      preferredModel: 'gpt-image-2.5-sunburst',
      actualModel: 'gpt-image-2.5-flare',
      fallbackUsed: true,
      fallbackFromModel: 'gpt-image-2.5-sunburst',
      fallbackReason: 'raw provider message!',
    };
    expect(parseCreativeGenerationProvenance(value)).toBeNull();
  });

  it('accepts attached video frames and requires their matching requested source', () => {
    const value = provenance();
    const videoAttached: Extract<CreativeGenerationProvenance['attachedSource'], { type: 'TRA_VIDEO_FRAMES' }> = {
      type: 'TRA_VIDEO_FRAMES', mediaId: videoId, sourceSha256: hash('b'), selectionMode: 'USER_SELECTED',
      frames: [{ timestampMs: 0, approvedPngSha256: hash('1') }, { timestampMs: 500, approvedPngSha256: hash('2') }],
    };
    value.attachedSource = videoAttached;
    expect(parseCreativeGenerationProvenance(value)?.attachedSource).toEqual(value.attachedSource);

    videoAttached.sourceSha256 = hash('f');
    expect(parseCreativeGenerationProvenance(value)).toBeNull();
  });

  it('round trips original and cropped provider pixels without treating a legacy record as assessed', () => {
    const value = provenance();
    value.attachedSource = { type: 'TRA_VIDEO_FRAMES', mediaId: videoId, sourceSha256: hash('b'),
      selectionMode: 'AUTOMATIC', frames: [{ timestampMs: 1333, approvedPngSha256: hash('1'),
        providerPngSha256: hash('2'), sourceOverlay: { version: 2, status: 'EDGE_CROP', edge: 'BOTTOM',
          removePermille: 400, overlayDepthPermille: 390 }, crop: { left: 0, top: 0, width: 100, height: 60 } }] };
    expect(parseCreativeGenerationProvenance(JSON.parse(JSON.stringify(value)))?.attachedSource).toEqual(value.attachedSource);
    const changed = structuredClone(value);
    if (changed.attachedSource?.type === 'TRA_VIDEO_FRAMES') changed.attachedSource.frames[0].crop = null;
    expect(parseCreativeGenerationProvenance(changed)).toBeNull();
    const legacy = provenance();
    legacy.attachedSource = { type: 'TRA_VIDEO_FRAMES', mediaId: videoId, sourceSha256: hash('b'),
      selectionMode: 'AUTOMATIC', frames: [{ timestampMs: 1333, approvedPngSha256: hash('1') }] };
    expect(parseCreativeGenerationProvenance(legacy)?.attachedSource).toEqual(legacy.attachedSource);
  });

  it.each([
    ['invalid media ID', (value: ReturnType<typeof provenance>) => { value.requestedSources[0].mediaId = '../media'; }],
    ['uppercase hash', (value: ReturnType<typeof provenance>) => { value.requestedSources[0].sha256 = hash('A'); }],
    ['blank model', (value: ReturnType<typeof provenance>) => { value.imageGeneration.model = ' '; }],
    ['long model', (value: ReturnType<typeof provenance>) => { value.imageGeneration.model = 'm'.repeat(201); }],
    ['too many frames', (value: ReturnType<typeof provenance>) => { value.attachedSource = { type: 'TRA_VIDEO_FRAMES', mediaId: videoId, sourceSha256: hash('b'), selectionMode: 'AUTOMATIC', frames: Array.from({ length: 4 }, (_, timestampMs) => ({ timestampMs, approvedPngSha256: hash(String(timestampMs + 1)) })) }; }],
    ['mismatched layout cache hash', (value: ReturnType<typeof provenance>) => { (value.analysisSources[0] as { layoutCache: { sourceSha256: string } }).layoutCache.sourceSha256 = hash('f'); }],
  ])('rejects %s', (_name, alter) => {
    const value = provenance();
    alter(value);
    expect(parseCreativeGenerationProvenance(value)).toBeNull();
  });

  it('keeps records and generated creatives compatible when provenance is absent', () => {
    const generated: GeneratedCreative = {
      id: 'creative_1', index: 0, category: 'customer-problems', format: 'native-social',
      image: { id: imageId, fileName: `${imageId}.png`, originalName: 'creative.png', mimeType: 'image/png', size: 1, url: '/creative.png' },
      copy: { primaryText: 'Primary', headline: 'Headline', description: 'Description' },
    };
    const record: CreativeRecord = {
      id: 'creative_2', createdAt: '2026-09-07T00:00:00.000Z', category: 'customer-problems', image: generated.image, copy: generated.copy,
    };
    expect(generated.generationProvenance).toBeUndefined();
    expect(record.generationProvenance).toBeUndefined();
  });
});
