import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreativeRecord } from '@/lib/creatives/generated';
import { fingerprintCreativeStrategy } from '@/lib/creatives/identity.server';
import type { HydratedCreativeSourceAsset } from '@/lib/media/source-hydration';
import type { MediaStorage } from '@/lib/media/storage';

const mocks = vi.hoisted(() => ({ hydrate: vi.fn(), frames: vi.fn(), human: vi.fn() }));
vi.mock('@/lib/video/approved-human-service', () => ({ requireActiveHumanSelection: mocks.human }));
vi.mock('@/lib/media/source-hydration', async (original) => ({
  ...await original<typeof import('@/lib/media/source-hydration')>(),
  hydrateCreativeSourceSelections: mocks.hydrate,
}));
vi.mock('@/lib/video/revision-frames', () => ({ resolveRevisionVideoFrames: mocks.frames }));

import { CreativeRevisionHydrationError, hydrateSavedCreativeRevisionContext } from '@/lib/creatives/revision-source-hydration';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const id = (hex: string) => `media_${hex.repeat(32)}`;
const strategy = (approved = true) => ({
  category: 'customer-problems' as const, awarenessStage: 'problem-aware' as const, persona: 'Taxpayer', painPoint: 'Tax debt', desiredOutcome: 'A clear plan', emotion: 'Relief', hook: 'Get clarity', cta: 'Talk to TRA', offer: null,
  soWhat: { surfaceMessage: 'Organize your case', functionalConsequence: 'Know your next step', meaningfulOutcome: 'Move forward with confidence' },
  execution: { subjectSource: approved ? 'approved-tra-human' as const : 'non-human' as const, composition: 'single-focus' as const, imageTreatment: 'photographic' as const, textDensity: 'low' as const, ctaTreatment: 'button' as const, typographyHierarchy: 'headline-dominant' as const }, visualDirection: 'Clean professional portrait',
});
const image = (value = PNG, mediaId = id('a')) => ({ fileName: `${mediaId}.png`, buffer: value, mimeType: 'image/png' as const });
const parent = (options: { attached?: 'reference' | 'video' | null; logo?: boolean; approved?: boolean } = {}): CreativeRecord => {
  const sourceId = id('b'); const logoId = id('c'); const plan = strategy(options.approved ?? options.attached !== null);
  const attached = options.attached === 'video'
    ? { type: 'TRA_VIDEO_FRAMES' as const, mediaId: sourceId, sourceSha256: hash(PNG), selectionMode: 'AUTOMATIC' as const, frames: [{ timestampMs: 0, approvedPngSha256: hash(PNG) }] }
    : options.attached === 'reference' || options.attached === undefined
      ? { type: 'TRA_REFERENCE_IMAGE' as const, mediaId: sourceId, sha256: hash(PNG) } : null;
  return {
    id: `creative_${'d'.repeat(32)}`, createdAt: '2026-09-07T00:00:00.000Z', image: { id: id('a'), fileName: `${id('a')}.png`, originalName: 'canvas.png', mimeType: 'image/png', size: PNG.length, url: '' }, category: 'customer-problems', copy: { primaryText: 'Primary', headline: 'Headline', description: '' }, format: 'direct-response', placement: 'PORTRAIT_4_5',
    planning: { strategy: plan, selectionReason: 'Saved strategy', model: 'planner', reasoningEffort: 'medium' },
    identity: { conceptId: `creative_${'d'.repeat(32)}`, parentCreativeId: null, operation: 'GENERATE', fingerprint: fingerprintCreativeStrategy(plan) },
    generationProvenance: { version: 1, imageGeneration: { prompt: 'saved prompt', model: 'gpt-image-2' }, requestedSources: attached ? [{ role: attached.type === 'TRA_VIDEO_FRAMES' ? 'TRA_VIDEO' as const : 'TRA_REFERENCE' as const, mediaId: sourceId, sha256: attached.type === 'TRA_VIDEO_FRAMES' ? attached.sourceSha256 : attached.sha256 }] : [], attachedSource: attached, analysisSources: [{ type: 'REFERENCE_LIBRARY', mediaId: id('e') }], ...(options.logo ? { logoOverlaySource: { mediaId: logoId, sha256: hash(PNG) } } : {}) },
  };
};
const source = (role: 'TRA_REFERENCE' | 'TRA_VIDEO' = 'TRA_REFERENCE'): HydratedCreativeSourceAsset => ({
  role, media: { id: id('b'), fileName: `${id('b')}.${role === 'TRA_VIDEO' ? 'mp4' : 'png'}`, mimeType: role === 'TRA_VIDEO' ? 'video/mp4' : 'image/png', mediaType: role === 'TRA_VIDEO' ? 'VIDEO' : 'IMAGE', size: PNG.length, url: '' } as HydratedCreativeSourceAsset['media'],
  stored: { ...image(PNG, id('b')), mediaType: 'IMAGE' } as HydratedCreativeSourceAsset['stored'],
});
const storage = (files: Record<string, ReturnType<typeof image> | null>) => ({ readImageById: vi.fn(async (mediaId: string) => files[mediaId] ?? null) }) as unknown as MediaStorage;

beforeEach(() => { mocks.hydrate.mockReset(); mocks.frames.mockReset(); mocks.human.mockReset(); });

describe('saved creative revision hydration', () => {
  it('checks selected library approval before hydrating its source for revision', async () => {
    const record = parent({ attached: 'video' });
    record.planning!.strategy.approvedHumanId = `human_${'a'.repeat(64)}`;
    record.identity!.fingerprint = fingerprintCreativeStrategy(record.planning!.strategy);
    mocks.human.mockRejectedValue(new Error('Selected human is inactive'));
    await expect(hydrateSavedCreativeRevisionContext(record, storage({ [id('a')]: image() }))).rejects.toMatchObject({status:409});
    expect(mocks.human).toHaveBeenCalledWith(record.planning!.strategy.approvedHumanId, record.videoFrameSelection);
    expect(mocks.hydrate).not.toHaveBeenCalled();
  });
  it('returns the saved canvas, TRA reference, and persisted logo without reading analysis assets', async () => {
    const record = parent({ logo: true }); const store = storage({ [id('a')]: image(), [id('c')]: image(PNG, id('c')) });
    mocks.hydrate.mockResolvedValue([source()]);
    const result = await hydrateSavedCreativeRevisionContext(record, store);
    expect(result.canvas).toMatchObject({ kind: 'EDITING_CANVAS', approvedHumanSource: false, sha256: hash(PNG) });
    expect(result.originalApprovedSource).toMatchObject({ kind: 'TRA_REFERENCE', sha256: hash(PNG) });
    expect(result.logoOverlay).toMatchObject({ kind: 'LOGO_OVERLAY', mediaId: id('c'), sha256: hash(PNG) });
    expect(mocks.hydrate).toHaveBeenCalledWith(store, [{ mediaId: id('b'), role: 'TRA_REFERENCE' }]);
    expect(store.readImageById).not.toHaveBeenCalledWith(id('e'));
  });

  it.each([
    ['missing context', () => ({ ...parent(), identity: undefined })],
    ['changed canvas metadata', () => ({ ...parent(), image: { ...parent().image, size: PNG.length + 1 } })],
    ['changed source hash', () => ({ ...parent(), generationProvenance: { ...parent().generationProvenance!, attachedSource: { ...parent().generationProvenance!.attachedSource as Exclude<NonNullable<CreativeRecord['generationProvenance']>['attachedSource'], null>, sha256: 'f'.repeat(64) }, requestedSources: [{ role: 'TRA_REFERENCE' as const, mediaId: id('b'), sha256: 'f'.repeat(64) }] } })],
  ])('rejects %s with actionable conflict context', async (_name, make) => {
    mocks.hydrate.mockResolvedValue([source()]);
    await expect(hydrateSavedCreativeRevisionContext(make(), storage({ [id('a')]: image() }))).rejects.toMatchObject({ status: 409 });
  });

  it('tells the operator how to recover from missing parent context', async () => {
    await expect(hydrateSavedCreativeRevisionContext({ ...parent(), identity: undefined }, storage({ [id('a')]: image() })))
      .rejects.toThrow('Generate and save a new creative before revising this item.');
  });

  it('maps missing canvas and original assets to 404', async () => {
    await expect(hydrateSavedCreativeRevisionContext(parent(), storage({}))).rejects.toMatchObject({ status: 404 });
    mocks.hydrate.mockRejectedValue(Object.assign(new Error('missing'), { name: 'CreativeSourceHydrationError', status: 404 }));
    await expect(hydrateSavedCreativeRevisionContext(parent(), storage({ [id('a')]: image() }))).rejects.toMatchObject({ status: 404 });
  });

  it('allows prompt-only revisions without an original source', async () => {
    const result = await hydrateSavedCreativeRevisionContext(parent({ attached: null, approved: false }), storage({ [id('a')]: image() }));
    expect(result.originalApprovedSource).toBeNull();
    expect(mocks.hydrate).not.toHaveBeenCalled();
  });

  it('delegates saved video frames and preserves its actionable error', async () => {
    const record = parent({ attached: 'video' }); mocks.hydrate.mockResolvedValue([source('TRA_VIDEO')]);
    mocks.frames.mockRejectedValue(new Error('Video intelligence is currently available in local development only.'));
    await expect(hydrateSavedCreativeRevisionContext(record, storage({ [id('a')]: image() }))).rejects.toThrow('local development only');
    expect(mocks.frames).toHaveBeenCalledWith(expect.anything(), record.generationProvenance!.attachedSource, undefined);
  });
});
