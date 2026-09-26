import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceCreativePortfolio } from '@/lib/creatives/portfolio-execution';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { newCreativePortfolio, retryPortfolioWork } from '@/lib/creatives/portfolio-job';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import type { CreativeRecord } from '@/lib/creatives/generated';
import { portfolioAudit } from '../fixtures/portfolio-audit';
import { MemoryPortfolioStorage, portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import { createVideoIntelligenceAnalyzerFingerprint } from '@/lib/video/intelligence-preparation';
import { videoIntelligenceJobId } from '@/lib/video/intelligence-job';
import { VideoRetryStateChangedError } from '@/lib/video/intelligence-job-store';
import { composePlanningCopyWithProof } from '@/lib/proof/planning-selection';
import { fetchCreativeImage } from '@/lib/creatives/image-models';
import { fetchWithProviderUsage, providerUsageContext } from '@/lib/ai/provider-telemetry';

const mocks = vi.hoisted(() => ({ prepareStep: vi.fn(), plan: vi.fn(), audit: vi.fn(), restore: vi.fn(), render: vi.fn(), list: vi.fn(),
  videoStep: vi.fn(), sourceAnalysisStep: vi.fn(), projectVideo: vi.fn(), loadVideo: vi.fn(), selectVideo: vi.fn() }));
vi.mock('@/lib/creatives/portfolio-preparation', () => ({ advancePortfolioPreparation: mocks.prepareStep }));
vi.mock('@/lib/creatives/portfolio-video-adapter', () => ({ stepPortfolioVideoDependency: mocks.videoStep }));
vi.mock('@/lib/creatives/planning-source-composition', async original => ({
  ...await original<typeof import('@/lib/creatives/planning-source-composition')>(), advancePlanningSourceAnalysis: mocks.sourceAnalysisStep,
}));
vi.mock('@/lib/creatives/video-intelligence-planning', async original => ({
  ...await original<typeof import('@/lib/creatives/video-intelligence-planning')>(), projectCompletedVideoIntelligence: mocks.projectVideo,
}));
vi.mock('@/lib/video/intelligence-finalization-runner', async original => ({
  ...await original<typeof import('@/lib/video/intelligence-finalization-runner')>(), loadVideoIntelligenceLibrary: mocks.loadVideo,
}));
vi.mock('@/lib/ai/creative-planner', () => ({
  requestCreativeBatch: mocks.plan,
  creativeRepairFeedback: (issue: string, audit: unknown) => `\nrepair:${issue}\n${JSON.stringify(audit)}`,
}));
vi.mock('@/lib/ai/portfolio-auditor', () => ({ auditCreativePortfolio: mocks.audit }));
vi.mock('@/lib/creatives/render-planned', () => ({ renderPlannedCreative: mocks.render }));
vi.mock('@/lib/creatives/portfolio-video-selection', async original => ({
  ...await original<typeof import('@/lib/creatives/portfolio-video-selection')>(),
  selectPortfolioVideoFrames: mocks.selectVideo,
}));
vi.mock('@/lib/creatives/storage', () => ({ listCreatives: mocks.list }));
vi.mock('@/lib/creatives/portfolio-snapshot', async original => ({
  ...await original<typeof import('@/lib/creatives/portfolio-snapshot')>(), restoreCreativePortfolio: mocks.restore,
}));
let records: CreativeRecord[] = [];
const analysis = { summary: 'Planning source summary', visibleText: [], visualStructure: 'Clear hierarchy', hookOrAngle: 'Clarity',
  offerOrCta: 'Talk with TRA', styleNotes: 'Calm', preserve: [], avoid: [], unknowns: [], dominantCategory: 'customer-problems' as const };
const unAuditedPlan = (request: ReturnType<typeof portfolioRequest>) => {
  const { portfolioAudit: _audit, ...plan } = portfolioSnapshot(newCreativePortfolio(request)).batchPlan;
  return plan;
};
const repeatedAudit = () => ({ ...portfolioAudit(2), groups: [{ conceptIndexes: [1, 2], proposition: 'Same reason to act', distinction: 'Paraphrases' }] });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const videoRequest = (count = 1) => ({ ...portfolioRequest(), sourceAssets: [
  ...Array.from({ length: count }, (_, index) => ({ role: 'TRA_VIDEO' as const, mediaId: `media_${String(index + 1).repeat(32)}` })),
  { role: 'LAYOUT_REFERENCE' as const, mediaId: `media_${'a'.repeat(32)}` },
] });
const videoDependency = (mediaId: string, complete = false) => {
  const sourceVideoContentHash = hash(mediaId), identity = { sourceVideoMediaId: mediaId, sourceVideoContentHash,
    analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'vision-model') };
  const artifactHash = hash('artifact-' + mediaId);
  return { version: 1 as const, identity, jobId: videoIntelligenceJobId(identity), ...(complete ? { completed: {
    artifact: { key: `libraries/sha256/${artifactHash}.json`, sha256: artifactHash, byteLength: 100 },
    library: { id: `video-library:${hash(`${mediaId}:${sourceVideoContentHash}`)}`, version: 1 as const },
  } } : {}) };
};

beforeEach(() => {
  records = []; mocks.prepareStep.mockReset(); mocks.plan.mockReset(); mocks.audit.mockReset(); mocks.restore.mockReset(); mocks.render.mockReset();
  mocks.list.mockReset().mockImplementation(async () => records);
  mocks.videoStep.mockReset(); mocks.sourceAnalysisStep.mockReset(); mocks.projectVideo.mockReset(); mocks.loadVideo.mockReset(); mocks.selectVideo.mockReset();
  mocks.plan.mockImplementation(async (args, repair) => {
    const plan = unAuditedPlan(portfolioRequest(args.count));
    if (!repair) return plan;
    return { ...plan, creatives: repair.repairPlan.replacementIndexes.map((index: number) => {
      const concept = structuredClone(plan.creatives[index - 1]);
      concept.index = index;
      concept.copy.headline = `Repaired headline ${index}`;
      if (concept.adCopy) concept.adCopy.headline = concept.copy.headline;
      if (concept.imageCopy) concept.imageCopy.headline = `Repaired image headline ${index}`;
      if (concept.strategy.conceptDetails) concept.strategy.conceptDetails.proposition = `Distinct repaired proposition ${index}`;
      concept.strategy.soWhat.surfaceMessage = `Distinct repaired outcome ${index}`;
      return concept;
    }) };
  });
  mocks.audit.mockImplementation(async concepts => portfolioAudit(concepts.length));
  mocks.prepareStep.mockImplementation(async (request, _url, _state, onProviderStart) => {
    onProviderStart();
    const plannerArgs = { count: request.variationCount, context: 'Prepared planning context', analysis,
      hasApprovedHumanSource: false, referenceCatalog: [] };
    const batchPlan = await mocks.plan(plannerArgs);
    return { prepared: { request, batchPlan, plannerArgs, referenceCatalog: [], selectedReferences: [], requestedSources: [], analysisSources: [],
      videoFrameSet: null, providerImageSource: null, brandLogo: null, reserveLogoArea: false } };
  });
  mocks.restore.mockImplementation(async snapshot => snapshot);
  mocks.render.mockImplementation(async (concept, context, options) => {
    await options.assertCurrentWork();
    const record: CreativeRecord = { id: options.creativeId, createdAt: '2026-09-11T00:00:00.000Z',
      category: concept.strategy.category, format: concept.format, placement: context.request.placement, copy: concept.copy,
      identity: buildCreativeIdentity({ creativeId: options.creativeId, operation: 'GENERATE', strategy: concept.strategy }),
      image: { id: 'media_' + 'a'.repeat(32), fileName: 'saved.png', originalName: 'saved.png', mimeType: 'image/png', size: 100, url: '/saved.png' } };
    records.push(record);
    return { ...record, index: concept.index };
  });
});

const readyPortfolio = async (
  storage: MemoryPortfolioStorage,
  request: Parameters<typeof createCreativePortfolio>[0] = portfolioRequest(),
  prepareSnapshot: (snapshot: ReturnType<typeof portfolioSnapshot>) => void = () => {},
) => {
  const job = await createCreativePortfolio(request, storage);
  const snapshot = portfolioSnapshot(job);
  prepareSnapshot(snapshot);
  return updateCreativePortfolio(job.id, current => ({
    ...current, snapshot, planning: { phase: 'READY_TO_RENDER' as const }, lease: null,
  }), storage);
};

it('retries portfolio finalization from saved purchased bytes without another image call', async () => {
  const storage = new MemoryPortfolioStorage(); const job = await readyPortfolio(storage);
  const finalize = mocks.render.getMockImplementation()!; let finalizations = 0;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'c2F2ZWQ=' }] })));
  mocks.render.mockImplementation(async (...args) => {
    await fetchCreativeImage('https://api.openai.com/v1/images/generations', { method: 'POST',
      body: JSON.stringify({ model: 'gpt-image-2.5-sunburst', prompt: 'Same approved plan', size: '1024x1024' }) });
    if (finalizations++ === 0) throw new Error('Interrupted finalization');
    return finalize(...args);
  });
  try {
    const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(failed.job.slots[0].status).toBe('RETRY_REQUIRED');
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, 1), storage);
    const recovered = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(recovered.job.slots[0].status).toBe('SAVED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { fetcher.mockRestore(); }
});

const composeD2Proof = (concept: any, length: number) => {
  const selectedProof = {
    type: 'review' as const, proofId: `proof_${'b'.repeat(32)}`,
    proofUpdatedAt: '2026-09-19T00:00:00.000Z', selectedText: 'Exact historical Review.', attribution: 'Approved reviewer',
  };
  const empty = composePlanningCopyWithProof(selectedProof, { ...concept.adCopy, primaryText: '' }, concept.imageCopy);
  const composed = composePlanningCopyWithProof(selectedProof, {
    ...concept.adCopy,
    primaryText: 'x'.repeat(length - empty.adCopy.primaryText.length),
  }, concept.imageCopy);
  Object.assign(concept, { copy: composed.adCopy, adCopy: composed.adCopy, imageCopy: composed.imageCopy, selectedProof });
};

const persistHistoricalCheckpoint = async (
  storage: MemoryPortfolioStorage,
  id: string,
  mutate: (concept: any) => void = concept => composeD2Proof(concept, 1001),
) => {
  const key = `creative-portfolios/v1/${id}.json`;
  const stored = await storage.read(key);
  if (!stored) throw new Error('Expected a saved portfolio checkpoint.');
  const historical = JSON.parse(stored.bytes.toString());
  mutate(historical.planning.checkpoint.snapshot.batchPlan.creatives[0]);
  await storage.write(key, Buffer.from(JSON.stringify(historical)), stored.etag);
  return readCreativePortfolio(id, storage);
};

const reachDiversityAudit = async (storage: MemoryPortfolioStorage) => {
  const job = await createCreativePortfolio(portfolioRequest(), storage);
  await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  return job;
};

const reachTerminalSecondAudit = async (storage: MemoryPortfolioStorage) => {
  const job = await reachDiversityAudit(storage);
  mocks.audit.mockResolvedValueOnce(repeatedAudit()).mockResolvedValueOnce(repeatedAudit());
  await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
  expect(failed.job).toMatchObject({
    planning: { phase: 'DIVERSITY_AUDIT', repairAttempted: true, checkpoint: {
      snapshot: { batchPlan: { portfolioAudit: expect.any(Object) } },
    } },
    planningError: expect.any(String),
  });
  return job;
};

describe('bounded resumable portfolio execution', () => {
  it.each([
    ['1,000-character modern Review Proof', (concept: any) => composeD2Proof(concept, 1000)],
    ['legacy copy-only', (concept: any) => { delete concept.adCopy; delete concept.imageCopy; }],
  ])('allows a serialized valid %s checkpoint through its audit', async (_name, mutate) => {
    const storage = new MemoryPortfolioStorage(), job = await reachDiversityAudit(storage);
    await persistHistoricalCheckpoint(storage, job.id, mutate);
    vi.clearAllMocks();
    mocks.audit.mockResolvedValue(portfolioAudit(2));

    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning.phase).toBe('READY_TO_RENDER');
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.plan).not.toHaveBeenCalled(); expect(mocks.selectVideo).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled(); expect(records).toHaveLength(0);
  });

  it.each([
    ['first DIVERSITY_AUDIT', async (storage: MemoryPortfolioStorage) => reachDiversityAudit(storage)],
    ['repaired DIVERSITY_AUDIT', async (storage: MemoryPortfolioStorage) => {
      const job = await reachDiversityAudit(storage);
      mocks.audit.mockResolvedValueOnce(repeatedAudit());
      await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
      await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
      return job;
    }],
    ['TARGETED_REPAIR', async (storage: MemoryPortfolioStorage) => {
      const job = await reachDiversityAudit(storage);
      mocks.audit.mockResolvedValueOnce(repeatedAudit());
      await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
      return job;
    }],
  ])('rejects a serialized pre-G1 invalid checkpoint before %s provider work, including explicit retry', async (_name, setup) => {
    const storage = new MemoryPortfolioStorage(), job = await setup(storage);
    const restored = await persistHistoricalCheckpoint(storage, job.id);
    const checkpoint = JSON.stringify((restored!.planning as any).checkpoint);
    vi.clearAllMocks();

    const first = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(first).toMatchObject({ status: 409, error: expect.stringContaining('invalid separated ad/image copy contract') });
    expect(first.job).toMatchObject({ planningError: expect.stringContaining('invalid separated ad/image copy contract'), lease: null });
    expect(JSON.stringify((first.job.planning as any).checkpoint)).toBe(checkpoint);
    expect(mocks.audit).not.toHaveBeenCalled(); expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.selectVideo).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled(); expect(records).toHaveLength(0);

    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, null), storage);
    const retried = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(retried).toMatchObject({ status: 409, error: expect.stringContaining('invalid separated ad/image copy contract') });
    expect(JSON.stringify((retried.job.planning as any).checkpoint)).toBe(checkpoint);
    expect(mocks.audit).not.toHaveBeenCalled(); expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.selectVideo).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled(); expect(records).toHaveLength(0);
  });

  it('keeps a serialized invalid terminal second-audit checkpoint frozen across repeated explicit Retry', async () => {
    const storage = new MemoryPortfolioStorage(), job = await reachTerminalSecondAudit(storage);
    const restored = await persistHistoricalCheckpoint(storage, job.id);
    expect(restored).not.toBeNull();
    expect(restored?.planning).toMatchObject({
      phase: 'DIVERSITY_AUDIT', repairAttempted: true,
      checkpoint: { snapshot: { batchPlan: { portfolioAudit: expect.any(Object) } } },
    });
    const checkpoint = JSON.stringify((restored!.planning as any).checkpoint);
    vi.clearAllMocks();

    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, null), storage);
      expect(rejected).toMatchObject({
        planning: { phase: 'DIVERSITY_AUDIT', repairAttempted: true },
        planningError: expect.stringContaining('invalid separated ad/image copy contract'),
        lease: null,
      });
      expect(JSON.stringify((rejected.planning as any).checkpoint)).toBe(checkpoint);
    }

    expect(mocks.prepareStep).not.toHaveBeenCalled(); expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled(); expect(mocks.videoStep).not.toHaveBeenCalled();
    expect(mocks.sourceAnalysisStep).not.toHaveBeenCalled(); expect(mocks.selectVideo).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled(); expect(records).toHaveLength(0);
  });

  it('still resets and replans a valid terminal second-audit quality failure on explicit Retry', async () => {
    const storage = new MemoryPortfolioStorage(), job = await reachTerminalSecondAudit(storage);
    vi.clearAllMocks();

    const authorized = await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, null), storage);
    expect(authorized).toMatchObject({
      planning: { phase: 'INITIAL_PLAN', preparation: { quotaReserved: true } },
      snapshot: null,
    });
    expect(authorized.planningError).toBeUndefined();

    const replanned = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(replanned.job.planning.phase).toBe('DIVERSITY_AUDIT');
    expect(mocks.prepareStep).toHaveBeenCalledOnce(); expect(mocks.plan).toHaveBeenCalledOnce();
    expect(mocks.audit).not.toHaveBeenCalled(); expect(mocks.videoStep).not.toHaveBeenCalled();
    expect(mocks.selectVideo).not.toHaveBeenCalled(); expect(mocks.render).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
  });

  it('rejects an invalid restored modern plan before automatic video selection, including explicit retry', async () => {
    const storage = new MemoryPortfolioStorage(), ready = await readyPortfolio(storage, videoRequest(), snapshot => {
      const invalid = snapshot.batchPlan.creatives[0];
      invalid.copy.primaryText = 'x'.repeat(1001);
      invalid.adCopy!.primaryText = 'x'.repeat(1001);
    });
    mocks.restore.mockImplementation(async saved => ({ ...saved, providerImageSource: null, videoFrameSet: {} }));

    const first = await advanceCreativePortfolio(ready.id, 'operator', 'http://localhost', storage);
    expect(first).toMatchObject({ status: 409, error: expect.stringContaining('invalid separated ad/image copy contract') });
    expect(first.job.slots[0].status).toBe('RETRY_REQUIRED');
    expect(mocks.selectVideo).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);

    await updateCreativePortfolio(ready.id, current => retryPortfolioWork(current, 1), storage);
    const retried = await advanceCreativePortfolio(ready.id, 'operator', 'http://localhost', storage);
    expect(retried).toMatchObject({ status: 409, error: expect.stringContaining('invalid separated ad/image copy contract') });
    expect(mocks.selectVideo).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
    const quotas = [...storage.data.keys()].filter(key => key.includes('/VIDEO_SELECTION.json') || key.includes('/CREATIVE_GENERATION.json'));
    expect(quotas).toEqual([]);
  });

  it('allows a 1,000-character modern restored plan through normal rendering', async () => {
    const storage = new MemoryPortfolioStorage(), ready = await readyPortfolio(storage, portfolioRequest(), snapshot => {
      const concept = snapshot.batchPlan.creatives[0];
      const selectedText = 'Exact Review Proof.';
      const attribution = 'Approved reviewer';
      const primaryText = `${'x'.repeat(1000 - selectedText.length - attribution.length - 4)}\n\n${selectedText}\n\n${attribution}`;
      concept.copy.primaryText = primaryText;
      concept.adCopy!.primaryText = primaryText;
      concept.imageCopy!.proofAttribution = attribution;
      concept.selectedProof = {
        type: 'review', proofId: `proof_${'a'.repeat(32)}`,
        proofUpdatedAt: '2026-09-19T00:00:00.000Z', selectedText, attribution,
      };
    });

    const result = await advanceCreativePortfolio(ready.id, 'operator', 'http://localhost', storage);
    expect(result.job.slots[0].status).toBe('SAVED');
    expect(mocks.render).toHaveBeenCalledOnce();
    expect(records).toHaveLength(1);
  });

  it('prepares multiple marked videos durably before layout/source analysis and never calls representative preparation early', async () => {
    const storage = new MemoryPortfolioStorage(), request = videoRequest(2);
    const job = await createCreativePortfolio(request, storage);
    expect(job.videoPreparationVersion).toBe(1);
    const calls = new Map<string, number>();
    mocks.videoStep.mockImplementation(async input => {
      const count = (calls.get(input.mediaId) ?? 0) + 1; calls.set(input.mediaId, count);
      const dependency = videoDependency(input.mediaId, count > 1);
      await input.checkpoint(dependency);
      return { dependency, status: count > 1 ? { jobId: dependency.jobId, phase: 'COMPLETE', busy: false,
        completedRepresentatives: 1, totalRepresentatives: 1, updatedAtMs: count, locator: {} } : null };
    });
    mocks.sourceAnalysisStep.mockResolvedValue({ state: { version: 1, entries: request.sourceAssets.map(source => ({ source })) } });
    mocks.loadVideo.mockResolvedValue({ id: 'library' });
    mocks.projectVideo.mockImplementation(() => { throw new Error('projection reached'); });
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage); // planning quota
    for (let index = 0; index < 4; index++) await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    const reloaded = await readCreativePortfolio(job.id, storage);
    expect(reloaded?.planning).toMatchObject({ phase: 'INITIAL_PLAN', preparation: {
      videoDependencies: [{ completed: expect.any(Object) }, { completed: expect.any(Object) }],
    } });
    expect(mocks.prepareStep).not.toHaveBeenCalled();
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(mocks.sourceAnalysisStep).toHaveBeenCalledOnce(); expect(mocks.loadVideo).toHaveBeenCalledTimes(2);
    expect(mocks.projectVideo).toHaveBeenCalledOnce(); expect(mocks.prepareStep).not.toHaveBeenCalled();
  });

  it('persists exact child retry state and consumes it only after explicit portfolio Retry', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(videoRequest(), storage);
    const mediaId = job.request.sourceAssets[0].mediaId, dependency = videoDependency(mediaId);
    const retryState = { jobId: dependency.jobId, updatedAtMs: 42,
      retry: { phase: 'TRANSCRIBING' as const, reason: 'PAID_WORK_FAILED' as const }, etag: 'child-etag' };
    mocks.videoStep.mockImplementationOnce(async input => { await input.checkpoint(dependency); return { dependency, status: null }; })
      .mockResolvedValueOnce({ dependency, status: { jobId: dependency.jobId, phase: 'RETRY_REQUIRED', busy: false,
        completedRepresentatives: 0, totalRepresentatives: 1, updatedAtMs: 42, retry: retryState.retry, locator: {} },
        retryAuthorization: retryState })
      .mockImplementationOnce(async input => {
        expect(input.action).toBe('RETRY'); expect(input.retryAuthorization).toEqual(retryState);
        await input.consumeRetryAuthorization(retryState);
        return { dependency: videoDependency(mediaId, true), status: { jobId: dependency.jobId, phase: 'COMPLETE', busy: false,
          completedRepresentatives: 1, totalRepresentatives: 1, updatedAtMs: 43, locator: {} } };
      });
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    const blocked = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(blocked.job).toMatchObject({ planningError: expect.stringContaining('Explicit Retry'), planning: { preparation: {
      videoProgress: { phase: 'RETRY_REQUIRED', retryState },
    } } });
    expect(mocks.videoStep).toHaveBeenCalledTimes(2);
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, null), storage);
    const completed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(completed.job.planning).toMatchObject({ preparation: { videoDependencies: [{ completed: expect.any(Object) }] } });
    expect(completed.job.planning.phase === 'INITIAL_PLAN'
      && completed.job.planning.preparation.videoRetryAuthorization).toBeUndefined();
  });

  it('refreshes a changed child retry revision read-only and requires another explicit Retry', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(videoRequest(), storage);
    const mediaId = job.request.sourceAssets[0].mediaId, dependency = videoDependency(mediaId);
    const first = { jobId: dependency.jobId, updatedAtMs: 42,
      retry: { phase: 'TRANSCRIBING' as const, reason: 'PAID_WORK_FAILED' as const }, etag: 'first' };
    const second = { ...first, updatedAtMs: 43, etag: 'second' };
    mocks.videoStep.mockImplementationOnce(async input => { await input.checkpoint(dependency); return { dependency, status: null }; })
      .mockResolvedValueOnce({ dependency, status: { jobId: dependency.jobId, phase: 'RETRY_REQUIRED', busy: false,
        completedRepresentatives: 0, totalRepresentatives: 1, updatedAtMs: 42, retry: first.retry, locator: {} }, retryAuthorization: first })
      .mockImplementationOnce(async input => { await input.consumeRetryAuthorization(first); throw new VideoRetryStateChangedError(); })
      .mockResolvedValueOnce({ dependency, status: { jobId: dependency.jobId, phase: 'RETRY_REQUIRED', busy: false,
        completedRepresentatives: 0, totalRepresentatives: 1, updatedAtMs: 43, retry: second.retry, locator: {} }, retryAuthorization: second })
      .mockImplementationOnce(async input => { await input.consumeRetryAuthorization(second); return {
        dependency: videoDependency(mediaId, true), status: { jobId: dependency.jobId, phase: 'COMPLETE', busy: false,
          completedRepresentatives: 1, totalRepresentatives: 1, updatedAtMs: 44, locator: {} } }; });
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, null), storage);
    const refreshed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(refreshed.job).toMatchObject({ planningError: expect.stringContaining('Explicit Retry'), planning: { preparation: {
      videoProgress: { retryState: second },
    } } });
    expect(refreshed.job.planning.phase === 'INITIAL_PLAN'
      && refreshed.job.planning.preparation.videoRetryAuthorization).toBeUndefined();
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, null), storage);
    const completed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(completed.job.planning.phase === 'INITIAL_PLAN'
      && completed.job.planning.preparation.videoDependencies?.[0].completed).toBeDefined();
  });
  it('persists planning before completing 36 single-image steps without double-charging quotas', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(36), storage);
    let result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning).toMatchObject({ phase: 'INITIAL_PLAN', preparation: { quotaReserved: true } });
    expect(mocks.prepareStep).not.toHaveBeenCalled();
    result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning.phase).toBe('DIVERSITY_AUDIT');
    expect(result.job.snapshot).toBeNull();
    expect(mocks.render).not.toHaveBeenCalled();
    result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning.phase).toBe('READY_TO_RENDER');
    expect(result.job.snapshot?.batchPlan.creatives).toHaveLength(36);
    for (let index = 1; index <= 36; index++) {
      result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
      expect(result.error).toBeUndefined();
      expect(result.job.slots.filter(slot => slot.status === 'SAVED')).toHaveLength(index);
    }
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(mocks.prepareStep).toHaveBeenCalledOnce();
    expect(mocks.plan).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.render).toHaveBeenCalledTimes(36);
    expect(records.map(record => record.id)).toEqual(job.slots.map(slot => slot.creativeId));
    const quotas = [...storage.data.entries()].filter(([key]) => key.startsWith('quotas/')).map(([, value]) => JSON.parse(value.bytes.toString()));
    expect(quotas).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'CREATIVE_PLANNING', usedUnits: 36 }),
      expect.objectContaining({ group: 'CREATIVE_GENERATION', usedUnits: 36 }),
    ]));
  });

  it('attributes batch planning and audit to the portfolio without a fabricated per-creative allocation', async () => {
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    const plan = mocks.plan.getMockImplementation()!, audit = mocks.audit.getMockImplementation()!;
    const observed = async (stage: string) => fetchWithProviderUsage(stage, 'gpt-6-astra', 'https://api.openai.com/v1/responses', {},
      async () => Response.json({ status: 'completed', usage: { input_tokens: 1 } }));
    mocks.plan.mockImplementation(async (...args) => { await observed('creative-plan'); return plan(...args); });
    mocks.audit.mockImplementation(async (...args) => { await observed('portfolio-audit'); return audit(...args); });
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(), storage);
    for (let step = 0; step < 3; step += 1) await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    const events = logs.mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(events).toHaveLength(4);
    for (const event of events) expect(event).toMatchObject({ runId: `portfolio:${job.id}`, jobId: job.id, portfolioId: job.id, creativeId: null });
    expect(providerUsageContext()).toEqual({});
    logs.mockRestore();
  });

  it('checkpoints pre-plan provider work before starting the next operation', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(), storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    mocks.prepareStep.mockImplementationOnce(async (_request, _url, state, onProviderStart) => {
      onProviderStart();
      return { state: { ...state, analysis } };
    });
    const checkpointed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(checkpointed.job.planning).toMatchObject({ phase: 'INITIAL_PLAN', preparation: { quotaReserved: true, analysis } });
    expect(mocks.plan).not.toHaveBeenCalled();
    const planned = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(planned.job.planning.phase).toBe('DIVERSITY_AUDIT');
    expect(mocks.prepareStep).toHaveBeenCalledTimes(2);
    expect(mocks.plan).toHaveBeenCalledOnce();
  });

  it('targets only duplicate concepts, preserves locked concepts, and globally re-audits the repaired portfolio', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(), storage);
    mocks.audit.mockResolvedValueOnce(repeatedAudit()).mockResolvedValueOnce(portfolioAudit(2));
    let result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning.phase).toBe('INITIAL_PLAN');
    result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning.phase).toBe('DIVERSITY_AUDIT');
    const initialConcepts = structuredClone((result.job.planning as any).checkpoint.snapshot.batchPlan.creatives);

    result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning).toMatchObject({ phase: 'TARGETED_REPAIR', repairPlan: { replacementIndexes: [2] } });
    const persistedRepair = await readCreativePortfolio(job.id, storage);
    expect(persistedRepair?.planning).toMatchObject({ phase: 'TARGETED_REPAIR', repairPlan: { replacementIndexes: [2] } });

    result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning).toMatchObject({ phase: 'DIVERSITY_AUDIT', repairAttempted: true });
    const repairedConcepts = (result.job.planning as any).checkpoint.snapshot.batchPlan.creatives;
    expect(repairedConcepts[0]).toEqual(initialConcepts[0]);
    expect(repairedConcepts[1]).not.toEqual(initialConcepts[1]);
    expect(mocks.plan.mock.calls[1][1]).toMatchObject({
      repairPlan: {
        replacementIndexes: [2],
        defects: [{
          replacementIndex: 2,
          type: 'SEMANTIC_DUPLICATE',
          relatedIndexes: [1, 2],
          description: 'Concepts 1, 2 repeat a strategic proposition: Same reason to act',
        }],
      },
      existingPortfolio: initialConcepts,
      lockedConcepts: [initialConcepts[0]],
      portfolioAudit: repeatedAudit(),
      plannerModel: 'gpt-6-astra',
    });

    result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(result.job.planning.phase).toBe('READY_TO_RENDER');
    expect(mocks.audit.mock.calls[1][0]).toEqual(repairedConcepts);
    expect(mocks.prepareStep).toHaveBeenCalledOnce();
    expect(mocks.plan).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    const planningQuota = [...storage.data.entries()].filter(([key]) => key.includes('/CREATIVE_PLANNING.json')).map(([, value]) => JSON.parse(value.bytes.toString()));
    expect(planningQuota).toEqual([expect.objectContaining({ usedUnits: 2 })]);
  });

  it('retries an interrupted audit explicitly without repeating the completed initial plan', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(), storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    mocks.audit.mockRejectedValueOnce(new Error('Audit connection lost'));
    const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(failed.job).toMatchObject({ planning: { phase: 'DIVERSITY_AUDIT' }, planningError: expect.any(String) });
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, null), storage);
    const retried = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(retried.job.planning.phase).toBe('READY_TO_RENDER');
    expect(mocks.prepareStep).toHaveBeenCalledOnce();
    expect(mocks.plan).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent advances and pauses known quota denials before provider work', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(36), storage);
    await Promise.all([1, 2].map(() => advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage)));
    expect(mocks.prepareStep).not.toHaveBeenCalled();
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(mocks.prepareStep).toHaveBeenCalledOnce();
    const second = await createCreativePortfolio(portfolioRequest(36), storage);
    const denied = await advanceCreativePortfolio(second.id, 'operator', 'http://localhost', storage);
    expect(denied).toMatchObject({ status: 429, job: { snapshot: null, lease: null } });
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(mocks.prepareStep).toHaveBeenCalledOnce();
  });

  it('requires explicit retry for a failed slot, preserves its ID, and never replans', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(), storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    mocks.render.mockRejectedValueOnce(new Error('Provider failed'));
    const failed = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(failed.job.slots[0].status).toBe('RETRY_REQUIRED');
    const continued = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(continued.job.slots.map(slot => slot.status)).toEqual(['RETRY_REQUIRED', 'SAVED']);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(mocks.render).toHaveBeenCalledTimes(2);
    await updateCreativePortfolio(job.id, current => retryPortfolioWork(current, 1), storage);
    const retried = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(retried.job.slots.every(slot => slot.status === 'SAVED')).toBe(true);
    expect(mocks.render.mock.calls[2][2].creativeId).toBe(job.slots[0].creativeId);
    expect(mocks.prepareStep).toHaveBeenCalledOnce();
  });

  it('recovers a saved image after a lost progress write before spending on another attempt', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(), storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    const write = storage.write.bind(storage); let dropped = false;
    storage.write = async (key, bytes, etag) => {
      if (!dropped && key.startsWith('creative-portfolios/') && JSON.parse(bytes.toString()).slots[0].status === 'SAVED') {
        dropped = true; throw new Error('Lost progress checkpoint');
      }
      return write(key, bytes, etag);
    };
    await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    const recovered = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage);
    expect(recovered.job.slots.every(slot => slot.status === 'SAVED')).toBe(true);
    expect(mocks.render).toHaveBeenCalledTimes(2);
    expect(records.map(record => record.id)).toEqual(job.slots.map(slot => slot.creativeId));
  });

  it('releases quota infrastructure failures without starting provider work', async () => {
    const storage = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(), storage);
    const write = storage.write.bind(storage);
    storage.write = async (key, bytes, etag) => {
      if (key.startsWith('quotas/')) throw new Error('Quota storage unavailable');
      return write(key, bytes, etag);
    };
    expect(await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage)).toMatchObject({ status: 503 });
    expect((await readCreativePortfolio(job.id, storage))?.lease).toBeNull();
    expect(mocks.prepareStep).not.toHaveBeenCalled();
  });
});
