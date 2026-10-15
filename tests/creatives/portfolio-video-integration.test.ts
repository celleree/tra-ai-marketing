import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { advanceCreativePortfolio } from '@/lib/creatives/portfolio-execution';
import { retryPortfolioWork } from '@/lib/creatives/portfolio-job';
import { createCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, getEffectiveIntervalFps } from '@/lib/video/candidate-policy';
import { analyzeFrameTechnicalQuality } from '@/lib/video/frame-technical-analysis';
import { createVideoFrameThumbnailFromBytes } from '@/lib/video/frame-thumbnail';
import { videoIntelligenceJobKey } from '@/lib/video/intelligence-job';
import { checkpointVideoIntelligenceJob } from '@/lib/video/intelligence-job-store';
import { createVideoIntelligenceAnalyzerFingerprint, type VideoIntelligencePreparationManifest } from '@/lib/video/intelligence-preparation';
import { MemoryPortfolioStorage, portfolioRequest } from '../fixtures/creative-portfolio';
import { conceptDetails } from '../fixtures/creative-concept-details';
import { portfolioAudit } from '../fixtures/portfolio-audit';
import { referenceCandidate } from '../fixtures/reference-catalog';

const boundary = vi.hoisted(() => ({ inventory: vi.fn(), hydration: vi.fn(), references: vi.fn(), humans: vi.fn(), representative: vi.fn(),
  layoutAngle: vi.fn(), layoutBlueprint: vi.fn() }));
vi.mock('@/lib/creatives/generation-sources', async original => ({
  ...await original<typeof import('@/lib/creatives/generation-sources')>(),
  hydratePlanningSourceInventory: boundary.inventory,
  hydrateGenerationSources: boundary.hydration,
}));
vi.mock('@/lib/references/storage', () => ({ listReferenceLibrary: boundary.references }));
vi.mock('@/lib/references/planning.server', async original => ({
  ...await original<typeof import('@/lib/references/planning.server')>(),
  advanceReferenceAngles: async () => null, withCuratedReferenceMetadata: async (catalog: unknown) => catalog,
}));
vi.mock('@/lib/video/approved-human-planning', () => ({ loadApprovedHumanOptions: boundary.humans }));
vi.mock('@/lib/layouts/service', () => ({ getOrAnalyzeContextualLayoutAngle: boundary.layoutAngle,
  getOrAnalyzeLayoutBlueprint: boundary.layoutBlueprint }));
vi.mock('@/lib/ai/video-frame-generation', async original => ({
  ...await original<typeof import('@/lib/ai/video-frame-generation')>(), analyzeApprovedTraVideoFrames: boundary.representative,
}));

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#663399' } }).jpeg().toBuffer();
const videoFixture = async (seed: string) => {
  const mediaId = `media_${seed.repeat(32)}`, sourceBytes = Buffer.from(`source-${seed}`), sourceHash = sha(sourceBytes);
  const identity = { sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash,
    analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'vision-model') };
  const candidate = { candidateIndex: 0, timestampMs: 1_500, sourceRole: 'TRA_VIDEO' as const,
    sourceVideoMediaId: mediaId, sourceVideoFileName: `${seed}.mp4`, sourceVideoContentHash: sourceHash,
    mimeType: 'image/jpeg' as const, width: 2, height: 2, byteLength: jpeg.length, frameSha256: sha(jpeg),
    extractionReasons: ['INTERVAL'] as const, providerEligible: false as const, technical: await analyzeFrameTechnicalQuality(jpeg) };
  const manifest: VideoIntelligencePreparationManifest = { version: 1, artifactType: 'VIDEO_INTELLIGENCE_PREPARATION', providerEligible: false,
    sourceVideoMediaId: mediaId, sourceVideoFileName: `${seed}.mp4`, sourceVideoContentHash: sourceHash,
    sourceVideoByteLength: sourceBytes.length, durationMs: 2_000,
    effectiveIntervalFps: getEffectiveIntervalFps(2_000, DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY),
    analyzerFingerprint: identity.analyzerFingerprint, candidates: [candidate], groups: [{ representativeIndex: 0, candidateIndexes: [0] }],
    representativeBundle: { key: `preparations/bundles/sha256/${sha(jpeg)}.bin`, sha256: sha(jpeg), byteLength: jpeg.length,
      entries: [{ candidateIndex: 0, offset: 0, byteLength: jpeg.length }] } };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const preparation = { manifestKey: `preparations/manifests/sha256/${sha(manifestBytes)}.json`, manifestSha256: sha(manifestBytes),
    durationMs: 2_000, representativeCandidateIndexes: [0] };
  const thumbnail = await createVideoFrameThumbnailFromBytes(candidate, jpeg);
  const observation = { version: 1 as const, model: 'vision-model', providerEligible: false as const,
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const, sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash,
    candidateIndex: 0, timestampMs: candidate.timestampMs, frameSha256: candidate.frameSha256,
    observation: { sceneType: 'OTHER' as const, summary: `LATE_OBSERVATION_${seed}`, composition: 'Full frame', visibleText: [],
      topics: ['other' as const], uncertainties: [] } };
  const hydrated = { role: 'TRA_VIDEO' as const,
    media: { id: mediaId, fileName: `${seed}.mp4`, mimeType: 'video/mp4' as const, mediaType: 'VIDEO' as const,
      size: sourceBytes.length, url: `/${seed}.mp4` },
    stored: { fileName: `${seed}.mp4`, mimeType: 'video/mp4' as const, mediaType: 'VIDEO' as const, buffer: sourceBytes } };
  return { mediaId, sourceHash, identity, candidate, manifest, manifestBytes, preparation, thumbnail, observation, hydrated };
};
const videos = [await videoFixture('b'), await videoFixture('c')];
const planned = (index: number) => {
  const adCopy = { primaryText: `Primary ${index}`, headline: `Headline ${index}`, description: '' };
  return { index, format: 'educational', copy: adCopy, adCopy: { ...adCopy },
    imageCopy: { headline: `Headline ${index}`, cta: 'Talk with TRA' },
    proofSelection: null,
    selectionReason: `Reason ${index}`, referenceChoices: { angleSource: null, layoutSource: null }, strategy: { conceptDetails,
      category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Taxpayer',
      painPoint: 'Uncertainty', desiredOutcome: 'Clarity', emotion: 'Relief', hook: 'Understand options', cta: 'Talk with TRA', offer: null,
      soWhat: { surfaceMessage: `Message ${index}`, functionalConsequence: 'See options', meaningfulOutcome: 'Move forward' },
      execution: { taxDocumentReference: 'none', subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'minimal-graphic',
        textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' }, visualDirection: 'Simple graphic' } };
};

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('sends two cold completed video libraries beside a layout to Astra and reuses child jobs for a second new portfolio', async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL_ENV', 'development'); vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'vision-model');
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  const storage = new MemoryPortfolioStorage(), now = () => 1_000;
  await storage.write(videos[0].manifest.representativeBundle.key, jpeg, null);
  for (const fixture of videos) await storage.write(fixture.preparation.manifestKey, fixture.manifestBytes, null);
  const layoutId = `media_${'d'.repeat(32)}`, layoutBytes = await sharp({ create: { width: 2, height: 2, channels: 3,
    background: '#fff' } }).png().toBuffer(), layoutHash = sha(layoutBytes);
  const sources = [...videos.map(fixture => ({ mediaId: fixture.mediaId, role: 'TRA_VIDEO' as const, sha256: fixture.sourceHash })),
    { mediaId: layoutId, role: 'LAYOUT_REFERENCE' as const, sha256: layoutHash }];
  boundary.inventory.mockResolvedValue([...videos.map((fixture, index) => ({ identity: sources[index], source: fixture.hydrated })),
    { identity: sources[2], source: { role: 'LAYOUT_REFERENCE', media: { id: layoutId }, stored: {
      fileName: 'layout.png', mimeType: 'image/png', mediaType: 'IMAGE', buffer: layoutBytes } } }]);
  boundary.hydration.mockResolvedValue({ storage: { readImageById: async (id: string) => id === layoutId
    ? { fileName: 'layout.png', mimeType: 'image/png', mediaType: 'IMAGE', buffer: layoutBytes } : null },
    generationSourceAsset: null, requestedSources: sources,
    source: null, providerImageSource: null, videoFrameSet: null, generatedVideoFrameSelection: null, brandLogo: null,
    reserveLogoArea: false, logoOverlaySource: null });
  boundary.references.mockResolvedValue([]); boundary.humans.mockResolvedValue([]);
  boundary.layoutAngle.mockImplementation(async (_source, _context, start) => { start(); return 'Layout angle'; });
  boundary.layoutBlueprint.mockResolvedValue({ blueprint: referenceCandidate('d').blueprint, analyzerModel: 'vision-model',
    contentHash: layoutHash, cacheHit: true });
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text',
    text: JSON.stringify({ creatives: [planned(1), planned(2)] }) }] }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const baseRequest = { ...portfolioRequest(), sourceAssets: sources.map(({ sha256: _hash, ...source }) => source) };
  const fixtureFor = (id: typeof videos[number]['identity']) => videos.find(fixture => fixture.mediaId === id.sourceVideoMediaId)!;
  const video = {
    now, hydrateSource: vi.fn(async (id: string) => videos.find(fixture => fixture.mediaId === id)!.hydrated),
    preparation: vi.fn(async (id: typeof videos[number]['identity'], lease: string) => checkpointVideoIntelligenceJob(id, lease,
      current => ({ ...current, phase: 'TRANSCRIBING', preparation: fixtureFor(id).preparation, lease: null }), { storage, now })),
    transcription: vi.fn(async (id: typeof videos[number]['identity'], lease: string) => checkpointVideoIntelligenceJob(id, lease,
      current => ({ ...current, phase: 'OBSERVING', lease: null, transcript: { version: 1, model: 'whisper-1',
        sourceVideoMediaId: id.sourceVideoMediaId, sourceVideoContentHash: id.sourceVideoContentHash, language: 'en',
        segments: [{ segmentIndex: 0, startMs: 1_000, endMs: 1_900, text: `LATE_TRANSCRIPT_${id.sourceVideoMediaId.at(-1)}` }] } }), { storage, now })),
    observation: vi.fn(async (id: typeof videos[number]['identity'], lease: string) => checkpointVideoIntelligenceJob(id, lease,
      current => ({ ...current, phase: 'OBSERVING', lease: null,
        representatives: [{ candidateIndex: 0, frameSha256: fixtureFor(id).candidate.frameSha256,
          thumbnail: fixtureFor(id).thumbnail, observation: fixtureFor(id).observation }] }), { storage, now })),
  };
  let firstCompleted: Awaited<ReturnType<typeof createCreativePortfolio>> | undefined;
  for (let portfolio = 0; portfolio < 2; portfolio++) {
    const request = { ...baseRequest, context: `Campaign ${portfolio === 0 ? 'b' : 'c'}` };
    const job = await createCreativePortfolio(request, storage); let current = job;
    for (let step = 0; step < 25 && current.planning.phase === 'INITIAL_PLAN'; step++) current = (await advanceCreativePortfolio(
      job.id, 'operator', 'http://localhost', storage, { deadlineAtMs: 2_000_000, video })).job;
    expect(current.planning.phase).toBe('DIVERSITY_AUDIT');
    if (portfolio === 0) firstCompleted = current;
  }
  expect(video.preparation).toHaveBeenCalledTimes(2); expect(video.transcription).toHaveBeenCalledTimes(2);
  expect(video.observation).toHaveBeenCalledTimes(2); expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(boundary.representative).not.toHaveBeenCalled();
  const outbound = JSON.parse(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).input[1].content[0].text);
  const videoEntries = outbound.sourceAnalysis.entries.filter((entry: any) => entry.result?.kind === 'VIDEO_INTELLIGENCE');
  expect(videoEntries).toHaveLength(2);
  expect(videoEntries.every((entry: any) => entry.result.intelligence.projectionVersion === 3)).toBe(true);
  expect(videoEntries.every((entry: any) => entry.result.intelligence.selector.contextSha256 === sha('Campaign b'))).toBe(true);
  expect(videoEntries.every((entry: any) => entry.result.intelligence.transcript.includedSegmentCount <= 24
    && entry.result.intelligence.observations.length <= 16
    && Buffer.byteLength(JSON.stringify(entry.result.intelligence)) <= 64 * 1024)).toBe(true);
  expect(videoEntries.every((entry: any) => Array.isArray(entry.result.intelligence.observationCoverage.buckets))).toBe(true);
  expect(videoEntries.map((entry: any) => entry.result.intelligence.observations[0].observation.summary)).toEqual(['LATE_OBSERVATION_b', 'LATE_OBSERVATION_c']);
  expect(outbound.sourceAnalysis.entries.some((entry: any) => entry.result?.kind === 'LAYOUT_BLUEPRINT')).toBe(true);
  expect(outbound.sourceAnalysisGuidance).toContain('deterministic exact-term lexical campaign matching');
  expect(outbound.sourceAnalysisGuidance).toContain('do not prove semantic relevance');
  expect(outbound.sourceAnalysisGuidance).toContain('not verified advertising evidence');
  expect(JSON.stringify(outbound)).not.toContain('thumbnailDataUrl');
  const byMedia = new Map<string, any>(videoEntries.map((entry: any) => [entry.source.mediaId, entry.result.intelligence]));
  expect(byMedia.get(videos[0].mediaId).transcript.lexicalCoverage.includedPositiveCandidateCount).toBe(1);
  expect(byMedia.get(videos[0].mediaId).observations[0].selectionReasons).toContain('CAMPAIGN_LEXICAL_MATCH');
  expect(byMedia.get(videos[1].mediaId).transcript.lexicalCoverage.includedPositiveCandidateCount).toBe(0);
  const secondOutbound = JSON.parse(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).input[1].content[0].text);
  expect(secondOutbound.sourceAnalysis.entries.find((entry: any) => entry.source.mediaId === videos[1].mediaId)
    .result.intelligence.observations[0].selectionReasons).toContain('CAMPAIGN_LEXICAL_MATCH');

  if (!firstCompleted || firstCompleted.planning.phase !== 'DIVERSITY_AUDIT') throw new Error('Expected saved first plan.');
  const savedAnalysis = structuredClone(firstCompleted.planning.checkpoint.plannerArgs.sourceAnalysis);
  const retryReads = vi.spyOn(storage, 'read');
  await updateCreativePortfolio(firstCompleted.id, saved => {
    if (saved.planning.phase !== 'DIVERSITY_AUDIT') throw new Error();
    saved.planning.repairAttempted = true; saved.planningError = 'Explicit retry';
    saved.planning.checkpoint.snapshot.batchPlan.portfolioAudit = portfolioAudit(2); return saved;
  }, storage);
  let retried = await updateCreativePortfolio(firstCompleted.id, saved => retryPortfolioWork(saved, null), storage);
  for (let step = 0; step < 4 && retried.planning.phase === 'INITIAL_PLAN'; step++) retried = (await advanceCreativePortfolio(
    firstCompleted.id, 'operator', 'http://localhost', storage, { deadlineAtMs: 2_000_000, video })).job;
  expect(retried.planning.phase).toBe('DIVERSITY_AUDIT');
  if (retried.planning.phase !== 'DIVERSITY_AUDIT') throw new Error();
  expect(retried.planning.checkpoint.plannerArgs.sourceAnalysis).toEqual(savedAnalysis);
  expect(retried.planning.checkpoint.snapshot.sourceAnalysis).toEqual(savedAnalysis);
  expect(retryReads.mock.calls.some(([key]) => key.startsWith('libraries/'))).toBe(false);
  expect(video.preparation).toHaveBeenCalledTimes(2); expect(video.transcription).toHaveBeenCalledTimes(2);
  expect(video.observation).toHaveBeenCalledTimes(2); expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('refreshes the child retry state immediately when its ETag changes after parent authorization consumption', async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('VERCEL_ENV', 'development'); vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'vision-model');
  class RetryConflictStorage extends MemoryPortfolioStorage {
    armed = false; parentWrites = 0;
    async write(key: string, bytes: Buffer, expected: string | null) {
      const written = await super.write(key, bytes, expected);
      if (written && this.armed && key.startsWith('creative-portfolios/v1/') && ++this.parentWrites === 2) {
        const childKey = videoIntelligenceJobKey(videos[0].identity), child = await this.read(childKey);
        if (!child || !await super.write(childKey, child.bytes, child.etag)) throw new Error('Failed to create child Retry conflict.');
      }
      return written;
    }
  }
  const storage = new RetryConflictStorage(), fixture = videos[0];
  const request = { ...portfolioRequest(), sourceAssets: [{ mediaId: fixture.mediaId, role: 'TRA_VIDEO' as const }] };
  const video = {
    hydrateSource: vi.fn(async () => fixture.hydrated),
    preparation: vi.fn(async (id: typeof fixture.identity, lease: string) => checkpointVideoIntelligenceJob(id, lease,
      current => ({ ...current, phase: 'TRANSCRIBING', preparation: fixture.preparation, lease: null }), { storage })),
    transcription: vi.fn(async (id: typeof fixture.identity, lease: string) => checkpointVideoIntelligenceJob(id, lease,
      current => ({ ...current, phase: 'RETRY_REQUIRED', lease: null, retry: {
        phase: 'TRANSCRIBING', reason: 'PAID_WORK_FAILED', message: 'Controlled failure',
      } }), { storage })),
  };
  const job = await createCreativePortfolio(request, storage); let current = job;
  for (let step = 0; step < 4; step++) current = (await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage,
    { deadlineAtMs: Date.now() + 300_000, video })).job;
  if (current.planning.phase !== 'INITIAL_PLAN') throw new Error('Expected video preparation.');
  const first = current.planning.preparation.videoProgress?.retryState;
  expect(current.planningError).toContain('Explicit Retry'); expect(first).toBeDefined();
  await updateCreativePortfolio(job.id, saved => retryPortfolioWork(saved, null), storage);
  storage.armed = true;
  const refreshed = (await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', storage,
    { deadlineAtMs: Date.now() + 300_000, video })).job;
  expect(storage.parentWrites).toBeGreaterThanOrEqual(2); expect(video.transcription).toHaveBeenCalledOnce();
  expect(refreshed.planningError).toContain('Explicit Retry');
  if (refreshed.planning.phase !== 'INITIAL_PLAN') throw new Error('Expected video preparation.');
  expect(refreshed.planning.preparation.videoRetryAuthorization).toBeUndefined();
  expect(refreshed.planning.preparation.videoProgress?.retryState).toMatchObject({
    jobId: first!.jobId, updatedAtMs: first!.updatedAtMs, retry: first!.retry,
  });
  expect(refreshed.planning.preparation.videoProgress?.retryState?.etag).not.toBe(first!.etag);
});