import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceCreativePortfolio } from '@/lib/creatives/portfolio-execution';
import { prepareCreativeGeneration } from '@/lib/creatives/prepare-generation';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { newCreativePortfolio, retryPortfolioWork, type CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import { restoreCreativePortfolio } from '@/lib/creatives/portfolio-snapshot';
import type { StoredCreativeSourceMediaFile } from '@/lib/media/types';
import { REAL_ENCODED_MP4 } from '../fixtures/media';
import { referenceCandidate } from '../fixtures/reference-catalog';
import { conceptDetails } from '../fixtures/creative-concept-details';
import { MemoryPortfolioStorage, portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';
import { portfolioAudit } from '../fixtures/portfolio-audit';

const mocks = vi.hoisted(() => ({ image: vi.fn(), angle: vi.fn(), video: vi.fn(), layout: vi.fn(), media: vi.fn(), frames: vi.fn(), audit: vi.fn(), library: vi.fn(), select: vi.fn() }));
vi.mock('@/lib/ai/openai', () => ({ analyzeTraSourceCreative: mocks.image, analyzeReferenceCreative: mocks.angle }));
vi.mock('@/lib/ai/video-frame-generation', async original => ({
  ...await original<typeof import('@/lib/ai/video-frame-generation')>(), analyzeApprovedTraVideoFrames: mocks.video,
}));
vi.mock('@/lib/layouts/service', () => ({ getOrAnalyzeLayoutBlueprint: mocks.layout, getLayoutBlueprintCache: () => ({
  readAngle: async (sourceSha256: string, analyzerModel: string) => ({ version: 1, sourceSha256, analyzerModel, angleSummary: 'Cached reusable angle' }),
}) }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: mocks.media }));
vi.mock('@/lib/video/tra-video-frames', () => ({ getApprovedTraVideoFrames: mocks.frames }));
vi.mock('@/lib/references/storage', () => ({ listAllReferenceLibrary: mocks.library, listReferenceLibrary: mocks.library }));
vi.mock('@/lib/ai/reference-selector', () => ({ selectBestReferenceCreatives: mocks.select }));
vi.mock('@/lib/video/approved-human-planning', () => ({ loadApprovedHumanOptions: async () => [] }));
vi.mock('@/lib/creatives/storage', () => ({ listCreatives: async () => [] }));
vi.mock('@/lib/ai/portfolio-auditor', () => ({ auditCreativePortfolio: mocks.audit }));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const analysis = (sentinel: string) => ({ summary: sentinel, visibleText: [], visualStructure: '', hookOrAngle: sentinel,
  offerOrCta: '', styleNotes: '', preserve: [], avoid: [], unknowns: [], dominantCategory: 'educational' as const });
const request = () => ({ ...portfolioRequest(), sourceAssets:
  (['TRA_VIDEO', 'TRA_REFERENCE', 'LAYOUT_REFERENCE', 'TRA_VIDEO', 'TRA_REFERENCE', 'LAYOUT_REFERENCE'] as const)
    .map((role, i) => ({ role, mediaId: `media_${String(i + 1).repeat(32)}` })) });
let operations: string[], outbound: Record<string, any>[], media: Record<string, StoredCreativeSourceMediaFile>;
beforeEach(() => {
  vi.clearAllMocks(); operations = []; outbound = []; media = {};
  mocks.audit.mockResolvedValue(portfolioAudit(2));
  mocks.library.mockResolvedValue([]); mocks.select.mockResolvedValue([]);
  vi.stubEnv('OPENAI_API_KEY', 'mock-key'); vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'analysis-model');
  for (const { role, mediaId } of request().sourceAssets) media[mediaId] = role === 'TRA_VIDEO'
    ? { fileName: `${mediaId}.mp4`, mediaType: 'VIDEO', mimeType: 'video/mp4', buffer: Buffer.from(REAL_ENCODED_MP4) }
    : { fileName: `${mediaId}.png`, mediaType: 'IMAGE', mimeType: 'image/png', buffer: png };
  mocks.media.mockReturnValue({ readMediaById: async (id: string) => media[id], readImageById: async (id: string) => media[id] });
  mocks.image.mockImplementation(async source => { operations.push(source.fileName); return analysis(source.fileName); });
  mocks.angle.mockImplementation(async source => { operations.push(source.fileName); return analysis(source.fileName); });
  mocks.layout.mockImplementation(async source => { operations.push(`layout:${source.fileName}`);
    return { blueprint: referenceCandidate().blueprint, analyzerModel: 'analysis-model', contentHash: hash(source.buffer), cacheHit: false }; });
  mocks.frames.mockImplementation(async source => ({ source, sourceVideoContentHash: hash(source.stored.buffer), durationMs: 1000, reused: true,
    frames: [{ frameIndex: 0, timestampMs: 500, mimeType: 'image/png', buffer: png, frameSha256: hash(png), byteLength: png.length,
      sourceRole: 'TRA_VIDEO', sourceVideoMediaId: source.media.id, sourceVideoFileName: source.media.fileName,
      sourceVideoContentHash: hash(source.stored.buffer), approvedHumanSource: true, cacheKey: null }] }));
  mocks.video.mockImplementation(async ({ frames }) => { operations.push(frames[0].sourceVideoFileName); return analysis(frames[0].sourceVideoFileName); });
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body); expect(body.model).toBe('gpt-6-astra');
    outbound.push(JSON.parse(body.input[1].content[0].text)); operations.push('Astra');
    const creatives = portfolioSnapshot(newCreativePortfolio(portfolioRequest())).batchPlan.creatives.map(c => ({ ...c,
      strategy: { ...c.strategy, conceptDetails: { ...conceptDetails, proposition: `Distinct proposition ${c.index}` },
        execution: { ...c.strategy.execution, taxDocumentReference: 'none' } }, referenceChoices: { angleSource: null, layoutSource: null } }));
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ creatives }) }] }] });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const step = (job: CreativePortfolioJob, storage: MemoryPortfolioStorage) => advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);

describe('real preparation to Astra with composed sources', () => {
  it.each([false, true])('checkpoints mixed/repeated sources before Astra, ordering=%s and stop/resume', async reversed => {
    const data = request(); if (reversed) data.sourceAssets.reverse();
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(data, storage);
    let current = job;
    for (let i = 0; i < 30 && current.planning.phase === 'INITIAL_PLAN'; i++) {
      const before = operations.length, result = await step(current, storage);
      expect(result.error).toBeUndefined(); current = result.job;
      expect(operations.length - before).toBeLessThanOrEqual(1);
      expect(current.lease).toBeNull(); expect(current.slots).toEqual(job.slots);
      const paused = operations.length;
      expect(await readCreativePortfolio(job.id, storage)).toEqual(current); expect(operations).toHaveLength(paused);
      if (current.planning.phase === 'INITIAL_PLAN' && current.planning.preparation.sourceAnalysis) {
        expect(current.planning.preparation.sourceAnalysis.entries.filter(e => e.result)).toHaveLength(operations.length);
        expect(outbound).toHaveLength(0);
      }
    }
    expect(current.planning.phase).toBe('DIVERSITY_AUDIT'); expect(operations).toHaveLength(11);
    const input = outbound[0]; expect(input.sourceAnalysis.entries).toHaveLength(10);
    for (const item of data.sourceAssets) expect(JSON.stringify(input.sourceAnalysis)).toContain(media[item.mediaId].fileName);
    expect(input.sourceAnalysisGuidance).toContain('not full Video Intelligence'); expect(input.referenceCatalog).toHaveLength(4);
    const ready = (await step(current, storage)).job;
    const restored = await restoreCreativePortfolio(ready.snapshot!);
    expect(restored.sourceAnalysis).toEqual(input.sourceAnalysis);
    expect(restored.providerImageSource?.media.id).toBe(data.sourceAssets.find(s => s.role === 'TRA_REFERENCE')!.mediaId);
    expect(restored.videoFrameSet).toBeNull(); expect(restored.generatedVideoFrameSelection).toBeUndefined();
    expect(ready.slots).toEqual(job.slots);
    const direct = await prepareCreativeGeneration(data, 'http://localhost');
    expect(outbound[1].sourceAnalysis).toEqual(input.sourceAnalysis);
    expect(direct.sourceAnalysis).toEqual(restored.sourceAnalysis);
    expect(direct.providerImageSource?.media.id).toBe(restored.providerImageSource?.media.id);
    expect(direct.videoFrameSet).toBeNull(); expect(outbound).toHaveLength(2);
  });

  it('reuses completed source and reference preparation after explicit retry of a failed second audit', async () => {
    const id = `media_${'a'.repeat(32)}`;
    const item = { id, fileName: `${id}.png`, originalName: 'Library layout', mimeType: 'image/png', size: png.length,
      url: `/api/media/files/${id}.png`, addedAt: '2026-09-12T00:00:00.000Z', referenceType: 'layout', angle: 'educational', angleSource: 'manual' };
    media[id] = { fileName: item.fileName, mimeType: 'image/png', mediaType: 'IMAGE', buffer: png };
    mocks.library.mockResolvedValue([item]);
    mocks.select.mockImplementation(async () => { operations.push('reference-selection');
      return [{ item, imageUrl: `http://localhost${item.url}`, selectionReason: 'Useful geometry' }]; });
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(request(), storage);
    let current = job;
    for (let i = 0; i < 30 && current.planning.phase === 'INITIAL_PLAN'; i++) current = (await step(current, storage)).job;
    if (current.planning.phase !== 'DIVERSITY_AUDIT') throw new Error('Missing initial plan');
    const checkpoint = structuredClone(current.planning.checkpoint);
    expect(checkpoint.snapshot.referenceCatalog).toHaveLength(5); expect(checkpoint.snapshot.selectedReferences).toHaveLength(1);
    mocks.audit.mockResolvedValue({ ...portfolioAudit(2), groups: [{ conceptIndexes: [1, 2], proposition: 'Same', distinction: 'Repeated' }] });
    for (let i = 0; i < 3; i++) current = (await step(current, storage)).job; // audit, repair, second audit
    expect(current.planningError).toBeTruthy(); expect(outbound).toHaveLength(2);
    expect((await step(current, storage)).job).toEqual(current);
    const retried = await updateCreativePortfolio(job.id, value => retryPortfolioWork(value, null), storage);
    expect(await readCreativePortfolio(job.id, storage)).toEqual(retried);
    expect(retried.planning).toMatchObject({ phase: 'INITIAL_PLAN', preparation: { quotaReserved: true,
      sourceAnalysis: checkpoint.plannerArgs.sourceAnalysis, referenceCatalog: checkpoint.snapshot.referenceCatalog,
      selectedReferences: checkpoint.snapshot.selectedReferences } });
    const before = operations.length, planned = await step(retried, storage);
    expect(planned.error).toBeUndefined(); expect(planned.job.planning.phase).toBe('DIVERSITY_AUDIT');
    expect(operations.slice(before)).toEqual(['Astra']); expect(outbound).toHaveLength(3);
    expect(outbound[2].sourceAnalysis).toEqual(outbound[0].sourceAnalysis);
    expect(outbound[2].referenceCatalog).toEqual(outbound[0].referenceCatalog);
    expect(planned.job.slots).toEqual(job.slots);
  });

  it.each(['provider', 'expired-lease', 'oversized-save'])('preserves completed work after %s until explicit retry', async failure => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(request(), storage);
    for (let i = 0; i < 3; i++) await step(job, storage); // quota, inventory, first video observation
    const checkpoint = await readCreativePortfolio(job.id, storage);
    mocks.image.mockImplementationOnce(async () => {
      if (failure === 'provider') throw new Error('Uncertain provider outcome');
      if (failure === 'expired-lease') await updateCreativePortfolio(job.id, current => ({ ...current,
        lease: { ...current.lease!, expiresAtMs: Date.now() - 1 } }), storage);
      return analysis(failure === 'oversized-save' ? 'x'.repeat(2 * 1024 * 1024) : 'Completed after lease expiry');
    });
    const failed = await step(job, storage);
    expect(failed.job.planningError).toBeTruthy(); expect(failed.job.planning).toEqual(checkpoint!.planning);
    expect((await step(job, storage)).job).toEqual(failed.job); expect(mocks.image).toHaveBeenCalledTimes(1);
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, null), storage);
    expect((await step(job, storage)).error).toBeUndefined();
    expect(mocks.video).toHaveBeenCalledTimes(1); expect(mocks.image).toHaveBeenCalledTimes(2); expect(outbound).toHaveLength(0);
    mocks.image.mockRejectedValueOnce(new Error('Single request uncertain'));
    await expect(prepareCreativeGeneration(request(), 'http://localhost')).rejects.toThrow('Single request uncertain');
    expect(mocks.image).toHaveBeenCalledTimes(3); expect(outbound).toHaveLength(0);
  });

  it.each(['', '   '])('stops changed sources and supports an empty angle %j', async angle => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(request(), storage);
    for (let i = 0; i < 3; i++) await step(job, storage);
    const saved = (await readCreativePortfolio(job.id, storage))!.planning;
    const id = request().sourceAssets[1].mediaId;
    media[id].buffer = Buffer.concat([png, Buffer.from('changed')]);
    expect((await step(job, storage)).error).toContain('changed');
    expect((await readCreativePortfolio(job.id, storage))!.planning).toEqual(saved);
    expect(mocks.image).not.toHaveBeenCalled(); expect(outbound).toHaveLength(0);
    mocks.angle.mockResolvedValueOnce(analysis(angle));
    const prepared = await prepareCreativeGeneration(request(), 'http://localhost');
    expect(prepared.referenceCatalog.some(item => item.angleDescription === 'No angle observed. Layout guidance only.')).toBe(true);
  });

  it('rejects render/analysis hash disagreement before the single-request Astra call', async () => {
    let reads = 0;
    const changedId = request().sourceAssets[1].mediaId;
    mocks.media.mockReturnValue({ readMediaById: async (id: string) => {
      reads++;
      return id === changedId && reads > 6 ? { ...media[id], buffer: Buffer.concat([png, Buffer.from('changed')]) } : media[id];
    } });
    await expect(prepareCreativeGeneration(request(), 'http://localhost')).rejects.toThrow('planning source analysis');
    expect(outbound).toHaveLength(0);
  });

  it.each([undefined, 1] as const)('resumes legacy partial/rendered jobs with marker %s without composing', async marker => {
    const job = { ...newCreativePortfolio(request()), sourceCompositionVersion: marker };
    job.planning = { phase: 'INITIAL_PLAN', preparation: { quotaReserved: true, analysis: analysis('SAVED_LEGACY'),
      sourceLayout: { blueprint: referenceCandidate().blueprint, contentHash: hash(png), analyzerModel: 'saved-model', cacheHit: true },
      referenceCatalog: [], selectedReferences: [] } };
    const storage = new MemoryPortfolioStorage();
    await storage.write(`creative-portfolios/v1/${job.id}.json`, Buffer.from(JSON.stringify(job)), null);
    const result = await step(job, storage);
    expect(result.error).toBeUndefined(); expect(outbound[0].referenceAnalysis.summary).toBe('SAVED_LEGACY');
    expect(outbound[0]).not.toHaveProperty('sourceAnalysis'); expect(operations).toEqual(['Astra']);
    const ready = (await step(job, storage)).job;
    const saved = await updateCreativePortfolio(job.id, current => ({ ...current,
      slots: current.slots.map(slot => ({ ...slot, status: 'SAVED' as const })) }), storage);
    expect((await step(job, storage)).job).toEqual(saved); expect(operations).toEqual(['Astra']);
    expect(saved.snapshot).toEqual(ready.snapshot); expect(saved.sourceCompositionVersion).toBe(marker);
  });
});
