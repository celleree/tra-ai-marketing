import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreparedCreativeGeneration } from '@/lib/creatives/prepare-generation';
import { snapshotCreativePortfolio, restoreCreativePortfolio } from '@/lib/creatives/portfolio-snapshot';

const hydrate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/creatives/generation-sources', async original => ({
  ...await original<typeof import('@/lib/creatives/generation-sources')>(), hydrateGenerationSources: hydrate,
}));
const hash = 'a'.repeat(64);
const prepared = () => ({
  request: { sourceAssets: [], placement: 'SQUARE_1_1', context: 'Frozen company direction', variationCount: 2 },
  batchPlan: { creatives: [], plannerModel: 'gpt-6-astra', reasoningEffort: 'medium',
    portfolioAudit: { version: 1, conceptCount: 2, groups: [], executionNotes: 'Frozen audit', model: 'gpt-6-astra' } },
  referenceCatalog: [], selectedReferences: [], requestedSources: [], analysisSources: [],
  storage: { saveImage: vi.fn() }, brandLogo: null, reserveLogoArea: false, videoFrameSet: null,
}) as unknown as PreparedCreativeGeneration;

describe('resumable creative portfolio snapshot', () => {
  beforeEach(() => { hydrate.mockReset(); });

  it('round-trips plan and audit without runtime buffers, functions or aliasing', async () => {
    const context = prepared();
    const snapshot = snapshotCreativePortfolio(context);
    expect(snapshot).not.toHaveProperty('storage');
    expect(snapshot).not.toHaveProperty('providerImageSource');
    context.request.context = 'Edited company direction';
    expect(snapshot.request.context).toBe('Frozen company direction');
    const reloaded = JSON.parse(JSON.stringify(snapshot));
    const current = prepared();
    hydrate.mockResolvedValue(current);
    const restored = await restoreCreativePortfolio(reloaded);
    expect(hydrate).toHaveBeenCalledWith(snapshot.request);
    expect(restored.batchPlan).toEqual(snapshot.batchPlan);
    expect(restored.storage).toBe(current.storage);
    restored.batchPlan.plannerModel = 'changed';
    expect(snapshot.batchPlan.plannerModel).toBe('gpt-6-astra');
  });

  it.each(['requestedSources', 'logoOverlaySource', 'generatedVideoFrameSelection', 'videoFrameSet'] as const)(
    'rejects changed %s before a renderer can use the saved plan', async field => {
      const context = prepared();
      const snapshot = snapshotCreativePortfolio(context);
      const changed = {
        requestedSources: [{ role: 'TRA_REFERENCE', mediaId: 'media_' + 'b'.repeat(32), sha256: hash }],
        logoOverlaySource: { mediaId: 'media_' + 'c'.repeat(32), sha256: hash },
        generatedVideoFrameSelection: { libraryId: 'changed' },
        videoFrameSet: { frames: [{ timestampMs: 1200, frameSha256: hash, buffer: Buffer.from('fresh') }] },
      };
      hydrate.mockResolvedValue({ ...context, [field]: changed[field] });
      await expect(restoreCreativePortfolio(snapshot)).rejects.toMatchObject({ status: 409 });
    });

  it('retains only frame identity and requires matching fresh pixels on resume', async () => {
    const context = prepared();
    context.videoFrameSet = { frames: [{ timestampMs: 1200, frameSha256: hash, buffer: Buffer.from('source') }] } as typeof context.videoFrameSet;
    const snapshot = snapshotCreativePortfolio(context);
    expect(snapshot.videoFrames).toEqual([{ timestampMs: 1200, sha256: hash }]);
    expect(JSON.stringify(snapshot)).not.toContain('buffer');
    const fresh = { ...context, videoFrameSet: structuredClone(context.videoFrameSet) };
    hydrate.mockResolvedValue(fresh);
    expect((await restoreCreativePortfolio(snapshot)).videoFrameSet).toBe(fresh.videoFrameSet);
  });

  it('propagates missing or invalid source errors rather than using saved eligibility', async () => {
    hydrate.mockRejectedValue(new Error('Source missing'));
    await expect(restoreCreativePortfolio(snapshotCreativePortfolio(prepared()))).rejects.toThrow('Source missing');
  });
});
