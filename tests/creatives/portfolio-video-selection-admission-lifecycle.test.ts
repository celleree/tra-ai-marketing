import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceCreativePortfolio } from '@/lib/creatives/portfolio-execution';
import { claimCreativePortfolio, finishPortfolioPlan, retryPortfolioWork } from '@/lib/creatives/portfolio-job';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { createPortfolioVideoSelectionConcept } from '@/lib/creatives/portfolio-video-selection';
import { reserveOperatorQuota } from '@/lib/quotas/operator-quota';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { HUMAN_FRAME_SELECTION_POLICY } from '@/lib/video/human-frame-selection';
import { MemoryPortfolioStorage, portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';

const mocks = vi.hoisted(() => ({ restore: vi.fn(), render: vi.fn(), inventory: vi.fn(), list: vi.fn(),
  loadContext: vi.fn(), extractFrames: vi.fn() }));
vi.mock('@/lib/creatives/portfolio-snapshot', async original => ({
  ...await original<typeof import('@/lib/creatives/portfolio-snapshot')>(), restoreCreativePortfolio: mocks.restore,
}));
vi.mock('@/lib/creatives/render-planned', () => ({ renderPlannedCreative: mocks.render }));
vi.mock('@/lib/creatives/generation-sources', async original => ({
  ...await original<typeof import('@/lib/creatives/generation-sources')>(), hydratePlanningSourceInventory: mocks.inventory,
}));
vi.mock('@/lib/creatives/storage', () => ({ listCreatives: mocks.list }));
vi.mock('@/lib/video/selection-context', () => ({ loadSavedVideoSelectionContext: mocks.loadContext,
  extractVideoSelectionFrames: mocks.extractFrames }));

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const jpeg = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#765432' } }).jpeg().toBuffer();
const mediaId = `media_${'a'.repeat(32)}`, sourceBytes = Buffer.from('admission-video'), sourceHash = sha(sourceBytes);
const source = { role: 'TRA_VIDEO', media: { id: mediaId, fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO',
  size: sourceBytes.length, url: '/source.mp4' }, stored: { fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO',
  buffer: sourceBytes } } as HydratedTraVideoSource;
const artifactSha = sha('library-artifact');
const identity = { sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash,
  analyzerFingerprint: { visionModel: 'vision-model', sha256: sha('fingerprint') } };
const artifact = { key: `libraries/sha256/${artifactSha}.json`, sha256: artifactSha, byteLength: 100 };
const emptyReuse = { version: 1 as const, frames: [] };

const visualPool = (imageCount: number) => {
  const frames = Array.from({ length: imageCount }, (_, candidateIndex) => ({
    id: `video-frame:${sha(`frame-${candidateIndex}`)}`, candidateIndexes: [candidateIndex], candidateIndex,
    timestampMs: 1_000 + candidateIndex, frameSha256: sha(jpeg), qualityScore: imageCount - candidateIndex,
    thumbnailDataUrl: 'data:image/jpeg;base64,unused-thumbnail', evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const,
    observation: { sceneType: 'PERSON' as const, summary: 'A visible person.', composition: 'Centered portrait.',
      visibleText: [], topics: ['person' as const], uncertainties: [] }, transcriptSegments: [],
  }));
  const library = { version: 1, id: `video-library:${sha(`library-${imageCount}`)}`, providerEligible: false,
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash,
    durationMs: imageCount + 2_000, analysisModels: { transcription: 'whisper-1', vision: ['vision-model'] },
    transcript: { version: 1, model: 'whisper-1', language: 'en', segments: [] },
    candidates: frames.map((frame) => ({ candidateIndex: frame.candidateIndex, timestampMs: frame.timestampMs,
      width: 96, height: 96, extractionReasons: ['INTERVAL'], frameSha256: frame.frameSha256, technical: {} })),
    representativeFrames: frames, semanticGroups: { sceneTypes: [], topics: [] } } as unknown as VideoFrameLibrary;
  const representativeImages = frames.map((frame) => ({ frameId: frame.id, candidateIndex: frame.candidateIndex,
    timestampMs: frame.timestampMs, frameSha256: frame.frameSha256, width: 96, height: 96, bytes: jpeg }));
  return { library, representativeImages };
};

const sourceAnalysis = (library: VideoFrameLibrary) => ({ version: 1, entries: [{
  source: { role: 'TRA_VIDEO', mediaId, sha256: sourceHash },
  analyzer: { kind: 'VIDEO_INTELLIGENCE', model: 'vision-model', schemaVersion: 1, contextSha256: null },
  evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', result: { kind: 'VIDEO_INTELLIGENCE', intelligence: {
    identity, jobId: `video-intelligence:${sha('job')}`, artifact, library: { id: library.id, version: library.version },
  } },
}] });

const ready = async (storage: MemoryPortfolioStorage, pool: ReturnType<typeof visualPool>) => {
  const request = { ...portfolioRequest(), sourceAssets: [{ role: 'TRA_VIDEO' as const, mediaId }] };
  const created = await createCreativePortfolio(request, storage);
  const claimed = await updateCreativePortfolio(created.id, current => claimCreativePortfolio(current, Date.now(), 'plan').job, storage);
  const snapshot = portfolioSnapshot(claimed) as any;
  await updateCreativePortfolio(created.id, current => finishPortfolioPlan(current, 'plan', snapshot), storage);
  return updateCreativePortfolio(created.id, current => { const next = structuredClone(current);
    next.slots[1].status = 'SAVED'; next.updatedAtMs = Date.now(); return next; }, storage);
};

const quotaUsed = (storage: MemoryPortfolioStorage) => [...storage.data.entries()]
  .filter(([key]) => key.endsWith('/VIDEO_SELECTION.json'))
  .map(([, value]) => JSON.parse(value.bytes.toString('utf8')).usedUnits as number);
const selectionKeys = (storage: MemoryPortfolioStorage) => [...storage.data.keys()].filter(key => key.startsWith('selections/'));
const assessments = (pool: ReturnType<typeof visualPool>) => pool.library.representativeFrames.map((frame) => ({
  libraryId: pool.library.id, frameId: frame.id, humanPresence: 'CLEAR', facialDetail: 'SUFFICIENT',
  eyes: 'OPEN_OR_NOT_VISIBLE', blur: 'CLEAR', occlusion: 'NONE_OR_MINOR', expressionUsability: 'NATURAL_OR_NEUTRAL',
  framing: 'USABLE', compositionFit: 'STRONG', observableReason: 'Visible suitable frame.',
  sourceOverlay: { version: 2, status: 'CLEAN' },
}));
const unsuitableAssessments = (pool: ReturnType<typeof visualPool>) => assessments(pool).map((assessment) => ({
  ...assessment, eyes: 'CLOSED_OR_BLINKING', observableReason: 'Eyes are closed in this frame.',
}));
const restoredContext = (snapshot: any, pool: ReturnType<typeof visualPool>) => {
  const restored = structuredClone(snapshot);
  restored.batchPlan.creatives[0].strategy.execution.subjectSource = 'approved-tra-human';
  restored.batchPlan.creatives[0].strategy.conceptDetails = { mainMessage: 'Understand the next step', proposition: 'Get a clear path',
    visualMechanism: 'Person reviewing a notice', subject: 'Person', environment: 'Home office' };
  return { ...restored, sourceAnalysis: sourceAnalysis(pool.library), storage: {}, providerImageSource: null,
    videoFrameSet: { source, frames: [{}] }, brandLogo: null, reserveLogoArea: false };
};

beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('OPENAI_API_KEY', 'test-only-dummy'); vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'frozen-model');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected live provider request'); }));
  mocks.list.mockResolvedValue([]); mocks.inventory.mockResolvedValue([{ source }]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('portfolio visual-selection admission lifecycle', () => {
  it('persists oversized admission as non-retryable without quota, provider, render, or cache-lease changes', async () => {
    const storage = new MemoryPortfolioStorage(), pool = visualPool(788);
    mocks.loadContext.mockResolvedValue({ library: pool.library, manifest: null, representativeImages: pool.representativeImages });
    mocks.restore.mockImplementation(async (snapshot) => restoredContext(snapshot, pool));
    await reserveOperatorQuota({ operatorId: 'operator', group: 'VIDEO_SELECTION', units: 1 }, { storage });
    const initial = await ready(storage, pool);

    const first = await advanceCreativePortfolio(initial.id, 'operator', 'http://localhost', storage);
    expect(first).toMatchObject({ status: 409, error: expect.stringContaining('smaller video pool') });
    expect(first.job).toMatchObject({ lease: null, slots: [{ status: 'BLOCKED', error: expect.stringContaining('saved creatives remain available') },
      { status: 'SAVED' }] });
    expect(quotaUsed(storage)).toEqual([1]); expect(selectionKeys(storage)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();

    const reloaded = await readCreativePortfolio(initial.id, storage);
    expect(reloaded?.slots[0]).toEqual(first.job.slots[0]);
    await expect(updateCreativePortfolio(initial.id, current => retryPortfolioWork(current, 1), storage)).rejects.toThrow('does not require a retry');
    await expect(updateCreativePortfolio(initial.id, current => { const next = structuredClone(current);
      next.slots[0].status = 'PENDING'; delete next.slots[0].error; return next; }, storage)).rejects.toThrow('may not replace');
    expect((await advanceCreativePortfolio(initial.id, 'operator', 'http://localhost', storage)).job.slots[0]).toEqual(first.job.slots[0]);
    expect(quotaUsed(storage)).toEqual([1]); expect(selectionKeys(storage)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();

    const legacy = await ready(storage, pool);
    await updateCreativePortfolio(legacy.id, current => { const next = structuredClone(current); next.slots[0] = { ...next.slots[0],
      status: 'RETRY_REQUIRED', error: 'Portfolio work could not be completed. Review its status before retrying.',
      videoSelection: { version: 2, selectionModel: 'frozen-model', selectionPolicy: HUMAN_FRAME_SELECTION_POLICY, reuseContext: emptyReuse } };
    next.updatedAtMs = Date.now(); return next; }, storage);
    await updateCreativePortfolio(legacy.id, current => retryPortfolioWork(current, 1), storage);
    const converted = await advanceCreativePortfolio(legacy.id, 'operator', 'http://localhost', storage);
    expect(converted.job.slots[0]).toMatchObject({ status: 'BLOCKED', error: expect.stringContaining('smaller video pool') });
    expect(converted.job.lease).toBeNull(); expect(quotaUsed(storage)).toEqual([1]); expect(selectionKeys(storage)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();
  });

  it('reuses a completed oversized cache result before outgoing admission or selection quota', async () => {
    const storage = new MemoryPortfolioStorage(), pool = visualPool(788);
    mocks.loadContext.mockResolvedValue({ library: pool.library, manifest: null, representativeImages: pool.representativeImages });
    mocks.restore.mockImplementation(async (snapshot) => restoredContext(snapshot, pool));
    const job = await ready(storage, pool); const concept = restoredContext(job.snapshot, pool).batchPlan.creatives[0];
    const brief = createPortfolioVideoSelectionConcept(concept), model = 'frozen-model';
    const libraries = [{ libraryId: pool.library.id, sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash,
      librarySha256: artifactSha, frames: pool.representativeImages.map(({ bytes: _bytes, ...frameIdentity }) => frameIdentity) }];
    const digest = sha(JSON.stringify([3, HUMAN_FRAME_SELECTION_POLICY, libraries, emptyReuse, brief, model]));
    await storage.write(`selections/sha256/${digest}.json`, Buffer.from(JSON.stringify({ version: 3,
      policy: HUMAN_FRAME_SELECTION_POLICY, libraries, reuseContext: emptyReuse, model, concept: brief, status: 'COMPLETE',
      outcome: { status: 'SELECTED', assessments: assessments(pool) } })), null);

    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.slots[0]).toMatchObject({ status: 'PENDING', videoSelection: { selection: {
      libraryId: pool.library.id, frameIds: [pool.library.representativeFrames[0].id] } } });
    expect(result.job.lease).toBeNull(); expect(quotaUsed(storage)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();
    expect((await readCreativePortfolio(job.id, storage))?.slots[0].videoSelection?.selection)
      .toEqual(result.job.slots[0].videoSelection?.selection);
  });

  it('blocks a completed no-suitable cache result without another selection charge or provider call', async () => {
    const storage = new MemoryPortfolioStorage(), pool = visualPool(2);
    mocks.loadContext.mockResolvedValue({ library: pool.library, manifest: null, representativeImages: pool.representativeImages });
    mocks.restore.mockImplementation(async (snapshot) => restoredContext(snapshot, pool));
    const job = await ready(storage, pool); const concept = restoredContext(job.snapshot, pool).batchPlan.creatives[0];
    const brief = createPortfolioVideoSelectionConcept(concept), model = 'frozen-model';
    const libraries = [{ libraryId: pool.library.id, sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash,
      librarySha256: artifactSha, frames: pool.representativeImages.map(({ bytes: _bytes, ...frameIdentity }) => frameIdentity) }];
    const digest = sha(JSON.stringify([3, HUMAN_FRAME_SELECTION_POLICY, libraries, emptyReuse, brief, model]));
    await storage.write(`selections/sha256/${digest}.json`, Buffer.from(JSON.stringify({ version: 3,
      policy: HUMAN_FRAME_SELECTION_POLICY, libraries, reuseContext: emptyReuse, model, concept: brief, status: 'COMPLETE',
      outcome: { status: 'NO_SUITABLE_HUMAN', assessments: unsuitableAssessments(pool) } })), null);

    const blocked = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(blocked).toMatchObject({ status: 409, job: { lease: null, slots: [{ status: 'BLOCKED',
      error: expect.stringContaining('clearer approved source') }, { status: 'SAVED' }] } });
    expect(quotaUsed(storage)).toEqual([]); expect(selectionKeys(storage)).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();
    expect((await readCreativePortfolio(job.id, storage))?.slots[0]).toEqual(blocked.job.slots[0]);
    await expect(updateCreativePortfolio(job.id, current => retryPortfolioWork(current, 1), storage)).rejects.toThrow('does not require a retry');
    expect((await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage)).job.slots[0]).toEqual(blocked.job.slots[0]);
    expect(quotaUsed(storage)).toEqual([]); expect(fetch).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();

    const legacy = await ready(storage, pool);
    await updateCreativePortfolio(legacy.id, current => { const next = structuredClone(current); next.slots[0] = { ...next.slots[0],
      status: 'RETRY_REQUIRED', error: 'Portfolio work could not be completed. Review its status before retrying.',
      videoSelection: { version: 2, selectionModel: model, selectionPolicy: HUMAN_FRAME_SELECTION_POLICY, reuseContext: emptyReuse } };
    next.updatedAtMs = Date.now(); return next; }, storage);
    await updateCreativePortfolio(legacy.id, current => retryPortfolioWork(current, 1), storage);
    const converted = await advanceCreativePortfolio(legacy.id, 'operator', 'http://localhost', storage);
    expect(converted.job.slots[0]).toMatchObject({ status: 'BLOCKED', error: expect.stringContaining('clearer approved source'),
      videoSelection: { selectionModel: model, selectionPolicy: HUMAN_FRAME_SELECTION_POLICY, reuseContext: emptyReuse } });
    expect(converted.job.lease).toBeNull(); expect(quotaUsed(storage)).toEqual([]); expect(fetch).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('admits cold work before quota, then persists the selected frame through the actual cache path', async () => {
    const storage = new MemoryPortfolioStorage(), pool = visualPool(2);
    mocks.loadContext.mockResolvedValue({ library: pool.library, manifest: null, representativeImages: pool.representativeImages });
    mocks.restore.mockImplementation(async (snapshot) => restoredContext(snapshot, pool));
    const provider = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'completed', output: [{ content: [
      { type: 'output_text', text: JSON.stringify({ assessments: assessments(pool) }) },
    ] }] }));
    vi.stubGlobal('fetch', provider);
    const job = await ready(storage, pool);

    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.slots[0]).toMatchObject({ status: 'PENDING', videoSelection: { selection: {
      libraryId: pool.library.id, frameIds: [pool.library.representativeFrames[0].id] } } });
    expect(result.job.lease).toBeNull(); expect(quotaUsed(storage)).toEqual([1]);
    expect(selectionKeys(storage)).toHaveLength(1); expect(provider).toHaveBeenCalledOnce(); expect(mocks.render).not.toHaveBeenCalled();
    expect((await readCreativePortfolio(job.id, storage))?.slots[0].videoSelection?.selection)
      .toEqual(result.job.slots[0].videoSelection?.selection);
  });

  it('charges one cold no-suitable evaluation, then durably blocks without rendering or reprocessing', async () => {
    const storage = new MemoryPortfolioStorage(), pool = visualPool(2);
    mocks.loadContext.mockResolvedValue({ library: pool.library, manifest: null, representativeImages: pool.representativeImages });
    mocks.restore.mockImplementation(async (snapshot) => restoredContext(snapshot, pool));
    const provider = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'completed', output: [{ content: [
      { type: 'output_text', text: JSON.stringify({ assessments: unsuitableAssessments(pool) }) },
    ] }] }));
    vi.stubGlobal('fetch', provider);
    const job = await ready(storage, pool);

    const blocked = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(blocked).toMatchObject({ status: 409, job: { lease: null, slots: [{ status: 'BLOCKED',
      error: expect.stringContaining('clearer approved source') }, { status: 'SAVED' }] } });
    expect(quotaUsed(storage)).toEqual([1]); expect(selectionKeys(storage)).toHaveLength(1);
    expect(provider).toHaveBeenCalledOnce(); expect(mocks.render).not.toHaveBeenCalled();
    expect((await readCreativePortfolio(job.id, storage))?.slots[0]).toEqual(blocked.job.slots[0]);
    await expect(updateCreativePortfolio(job.id, current => retryPortfolioWork(current, 1), storage)).rejects.toThrow('does not require a retry');
    expect((await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage)).job.slots[0]).toEqual(blocked.job.slots[0]);
    expect(quotaUsed(storage)).toEqual([1]); expect(provider).toHaveBeenCalledOnce(); expect(mocks.render).not.toHaveBeenCalled();
  });

  it('keeps actual quota denial ahead of cache lease and provider work with the parent lease released', async () => {
    const storage = new MemoryPortfolioStorage(), pool = visualPool(2);
    mocks.loadContext.mockResolvedValue({ library: pool.library, manifest: null, representativeImages: pool.representativeImages });
    mocks.restore.mockImplementation(async (snapshot) => restoredContext(snapshot, pool));
    await reserveOperatorQuota({ operatorId: 'operator', group: 'VIDEO_SELECTION', units: 24 }, { storage });
    const job = await ready(storage, pool);

    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result).toMatchObject({ status: 429, job: { lease: null, slots: [{ status: 'PENDING' }, { status: 'SAVED' }] } });
    expect(quotaUsed(storage)).toEqual([24]); expect(selectionKeys(storage)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();
  });
});
