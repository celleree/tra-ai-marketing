import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { requestCreativeBatch } from '@/lib/ai/creative-planner';
import { projectCompletedVideoIntelligence, parseVideoPlanningContext,
  MAX_PLANNING_VIDEO_OBSERVATIONS, MAX_PLANNING_VIDEO_TRANSCRIPT_EXCERPTS } from '@/lib/creatives/video-intelligence-planning';
import { claimCreativePortfolio, finishPortfolioInitialPlan, newCreativePortfolio, retryPortfolioWork } from '@/lib/creatives/portfolio-job';
import { readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { parseCreativePortfolioJob } from '@/lib/creatives/portfolio-job-parser';
import { parsePlanningSourceAnalysis } from '@/lib/creatives/planning-source-parser';
import type { PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';
import type { PortfolioVideoDependency } from '@/lib/creatives/portfolio-video-dependency';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import { createVideoIntelligenceAnalyzerFingerprint } from '@/lib/video/intelligence-preparation';
import { videoIntelligenceJobId } from '@/lib/video/intelligence-job';
import { referenceCandidate } from '../fixtures/reference-catalog';
import { MemoryPortfolioStorage, portfolioSnapshot } from '../fixtures/creative-portfolio';
import { conceptDetails } from '../fixtures/creative-concept-details';
import { portfolioAudit } from '../fixtures/portfolio-audit';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const jpeg = (await sharp({ create: { width: 1, height: 1, channels: 3, background: '#888' } }).jpeg().toBuffer()).toString('base64');
const analysis = { summary: 'Source', visibleText: [], visualStructure: 'Simple', hookOrAngle: 'Clear', offerOrCta: 'Talk',
  styleNotes: 'Calm', preserve: [], avoid: [], unknowns: [], dominantCategory: 'customer-problems' as const };
const videoSource = (hex: string) => ({ role: 'TRA_VIDEO' as const, mediaId: `media_${hex.repeat(32)}`, sha256: hash(`video-${hex}`) });
const dependency = (source: ReturnType<typeof videoSource>): PortfolioVideoDependency => {
  const identity = { sourceVideoMediaId: source.mediaId, sourceVideoContentHash: source.sha256,
    analyzerFingerprint: createVideoIntelligenceAnalyzerFingerprint(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY, 'vision-model') };
  const artifactHash = hash(`artifact-${source.mediaId}`);
  return { version: 1, identity, jobId: videoIntelligenceJobId(identity), completed: {
    artifact: { key: `libraries/sha256/${artifactHash}.json`, sha256: artifactHash, byteLength: 100 },
    library: { version: 1, id: `video-library:${hash(`${source.mediaId}:${source.sha256}`)}` },
  } };
};
const library = (source: ReturnType<typeof videoSource>, count: number, silent = false): VideoFrameLibrary => {
  const segments = silent ? [] : Array.from({ length: count }, (_, segmentIndex) => ({ segmentIndex,
    startMs: segmentIndex * 1000, endMs: segmentIndex * 1000 + 900, text: segmentIndex === count - 1 ? 'DISTINCTIVE_LATE_TRANSCRIPT' : `Speech ${segmentIndex}` }));
  const candidates = Array.from({ length: count }, (_, candidateIndex) => {
    const frameSha256 = hash(`${source.mediaId}-frame-${candidateIndex}`), timestampMs = candidateIndex * 1000 + 100;
    return { candidateIndex, timestampMs, width: 1, height: 1, extractionReasons: ['INTERVAL'] as const, frameSha256,
      technical: { version: 1 as const, analysisWidth: 1, analysisHeight: 1, differenceHash: '0'.repeat(16), meanRgb: [1, 2, 3] as [number, number, number],
        meanLuminance: 2, luminanceDeviation: 1, laplacianVariance: 1, darkFraction: 0, lightFraction: 0, qualityScore: 1 } };
  });
  const representativeFrames = candidates.map((candidate, index) => ({ id: `video-frame:${hash(`${source.sha256}:${candidate.timestampMs}:${candidate.frameSha256}`)}`,
    candidateIndexes: [index], ...candidate, qualityScore: 1, thumbnailDataUrl: `data:image/jpeg;base64,${jpeg}`,
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const,
    observation: { sceneType: 'OTHER' as const, summary: index === count - 1 ? 'DISTINCTIVE_LATE_OBSERVATION' : `Frame ${index}`,
      composition: 'Simple', visibleText: [], topics: ['other' as const], uncertainties: [] }, transcriptSegments: [] }));
  return { version: 1, id: `video-library:${hash(`${source.mediaId}:${source.sha256}`)}`, providerEligible: false,
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', sourceVideoMediaId: source.mediaId, sourceVideoContentHash: source.sha256,
    durationMs: Math.max(1000, count * 1000), analysisModels: { transcription: silent ? null : 'whisper-1', vision: ['vision-model'] },
    transcript: silent ? { version: 1, status: 'SKIPPED_NO_AUDIO_TRACK', model: null, language: null, segments: [], evidence: { method: 'FFMPEG_STREAM_METADATA' } }
      : { version: 1, model: 'whisper-1', language: 'en', segments },
    candidates, representativeFrames, semanticGroups: { sceneTypes: [], topics: [] } };
};
const baseState = (sources: ReturnType<typeof videoSource>[]): PlanningSourceAnalysisState => {
  const layout = { role: 'LAYOUT_REFERENCE' as const, mediaId: `media_${'c'.repeat(32)}`, sha256: 'c'.repeat(64) };
  return { version: 1, entries: [...sources.map(source => ({ source, analyzer: { kind: 'REPRESENTATIVE_VIDEO_FRAMES' as const,
    model: 'old-model', schemaVersion: 1 as const, contextSha256: 'a'.repeat(64) }, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const,
    result: { kind: 'REPRESENTATIVE_VIDEO_FRAMES' as const, analysis, analyzedFrames: [{ timestampMs: 0, frameSha256: source.sha256 }] } })),
  { source: layout, analyzer: { kind: 'LAYOUT_ANGLE', model: 'layout-model', schemaVersion: 1, contextSha256: 'b'.repeat(64) },
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', result: { kind: 'LAYOUT_ANGLE', angleDescription: 'Keep this layout angle' } },
  { source: layout, analyzer: { kind: 'LAYOUT_BLUEPRINT', model: 'layout-model', schemaVersion: 1, contextSha256: null },
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', result: { kind: 'LAYOUT_BLUEPRINT', layout: {
      blueprint: referenceCandidate().blueprint, contentHash: layout.sha256, analyzerModel: 'layout-model', cacheHit: true } } }] };
};
const plannedConcept = (index: number) => ({ index, format: 'educational', copy: { primaryText: `Primary ${index}`, headline: `Headline ${index}`, description: '' },
  selectionReason: `Reason ${index}`, strategy: { conceptDetails, category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Taxpayer',
    painPoint: 'Uncertainty', desiredOutcome: 'Clarity', emotion: 'Relief', hook: 'Understand options', cta: 'Talk with TRA', offer: null,
    soWhat: { surfaceMessage: `Message ${index}`, functionalConsequence: 'See options', meaningfulOutcome: 'Move forward' },
    execution: { taxDocumentReference: 'none', subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'minimal-graphic', textDensity: 'low',
      ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' }, visualDirection: 'Simple graphic' } });
const ok = () => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ creatives: [plannedConcept(1), plannedConcept(2)] }) }] }] }), { status: 200 });

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('projects multiple completed libraries with explicit bounded timeline coverage and sends them beside layout data to Astra', async () => {
  const sources = [videoSource('a'), videoSource('b')], dependencies = sources.map(dependency);
  const projected = projectCompletedVideoIntelligence(baseState(sources), [
    { dependency: dependencies[0], library: library(sources[0], 30) }, { dependency: dependencies[1], library: library(sources[1], 1, true) }]);
  expect(parsePlanningSourceAnalysis(projected, [...sources, projected.entries[2].source], true)).toEqual(projected);
  const intelligence = projected.entries.flatMap(entry => entry.result?.kind === 'VIDEO_INTELLIGENCE' ? [entry.result.intelligence] : []);
  expect(intelligence[0].transcript).toMatchObject({ totalSegmentCount: 30, coverage: 'UNIFORM_TIMELINE_V1' });
  expect(intelligence[0].transcript.excerpts).toHaveLength(MAX_PLANNING_VIDEO_TRANSCRIPT_EXCERPTS);
  expect(intelligence[0].transcript.excerpts.at(-1)).toMatchObject({ startMs: 29000, text: 'DISTINCTIVE_LATE_TRANSCRIPT' });
  expect(intelligence[0].observations).toHaveLength(MAX_PLANNING_VIDEO_OBSERVATIONS);
  expect(intelligence[0].observations.at(-1)).toMatchObject({ timestampMs: 29100, observation: { summary: 'DISTINCTIVE_LATE_OBSERVATION' } });
  expect(intelligence[1].transcript).toMatchObject({ status: 'NO_AUDIO_TRACK', totalSegmentCount: 0, coverage: 'COMPLETE' });
  expect(JSON.stringify(projected)).not.toContain('thumbnailDataUrl');
  expect(projected.entries.slice(-2)).toEqual(baseState(sources).entries.slice(-2));
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => ok()); vi.stubGlobal('fetch', fetchMock);
  await requestCreativeBatch({ count: 2, context: 'TRA', analysis, sourceAnalysis: projected, hasApprovedHumanSource: false });
  expect(fetchMock).toHaveBeenCalledOnce();
  const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  const outbound = JSON.parse(request.input[1].content[0].text);
  expect(outbound.sourceAnalysis).toEqual(projected);
  expect(outbound.sourceAnalysisGuidance).toContain('not verified advertising evidence');
  expect(outbound.sourceAnalysisGuidance).toContain('grant no claims, human approval');
});

it('rejects incomplete, mismatched, malformed and oversized completed projections without provider work', () => {
  const source = videoSource('a'), complete = dependency(source), full = library(source, 30);
  expect(() => projectCompletedVideoIntelligence(baseState([source]), [{ dependency: { ...complete, completed: undefined }, library: full }])).toThrow();
  expect(() => projectCompletedVideoIntelligence(baseState([{ ...source, sha256: 'f'.repeat(64) }]), [{ dependency: complete, library: full }])).toThrow();
  const projected = projectCompletedVideoIntelligence(baseState([source]), [{ dependency: complete, library: full }]);
  const context = (projected.entries[0].result as { kind: 'VIDEO_INTELLIGENCE'; intelligence: any }).intelligence;
  const invalid = [
    { ...context, observations: [{ ...context.observations[0], transcriptSegments: [{}] }, ...context.observations.slice(1)] },
    { ...context, observations: [{ ...context.observations[0], id: `video-frame:${'f'.repeat(64)}` }, ...context.observations.slice(1)] },
    { ...context, observations: [context.observations[0], context.observations[0]], observationCoverage: { totalRepresentativeCount: 2, coverage: 'COMPLETE' } },
    { ...context, observations: [], observationCoverage: { totalRepresentativeCount: 0, coverage: 'COMPLETE' } },
    { ...context, library: { ...context.library, analysisModels: { ...context.library.analysisModels, transcription: null } } },
  ];
  for (const value of invalid) expect(() => parseVideoPlanningContext(value, { mediaId: source.mediaId, sha256: source.sha256 })).toThrow();
  const oversized = structuredClone(context);
  oversized.transcript = { ...oversized.transcript, totalSegmentCount: 24, coverage: 'COMPLETE',
    excerpts: Array.from({ length: 24 }, (_, segmentIndex) => ({ segmentIndex, startMs: segmentIndex * 1000,
      endMs: segmentIndex * 1000 + 900, text: 'x'.repeat(3000) })) };
  expect(() => parseVideoPlanningContext(oversized, { mediaId: source.mediaId, sha256: source.sha256 })).toThrow();
});

it('preserves exact completed dependencies through the real initial-plan checkpoint and parser reload', async () => {
  const source = videoSource('a'), savedDependency = dependency(source);
  const projected = projectCompletedVideoIntelligence(baseState([source]), [{ dependency: savedDependency, library: library(source, 2) }]);
  const request = { context: 'TRA', placement: 'SQUARE_1_1' as const, variationCount: 2,
    sourceAssets: [...new Map(projected.entries.map(entry => [entry.source.mediaId, { role: entry.source.role, mediaId: entry.source.mediaId }])).values()] };
  const created = { ...newCreativePortfolio(request, 1000), videoPreparationVersion: 1 as const };
  if (created.planning.phase !== 'INITIAL_PLAN') throw new Error();
  created.planning.preparation = { quotaReserved: true, videoDependencies: [savedDependency] };
  const storage = new MemoryPortfolioStorage();
  await storage.write(`creative-portfolios/v1/${created.id}.json`, Buffer.from(JSON.stringify(created)), null);
  await updateCreativePortfolio(created.id, job => claimCreativePortfolio(job, 2000, 'plan').job, storage);
  const plannerArgs = { count: 2, context: 'TRA', analysis, sourceAnalysis: projected, hasApprovedHumanSource: false };
  const snapshot = { ...portfolioSnapshot(created), request, requestedSources: [...new Map(projected.entries.map(entry => [entry.source.mediaId, entry.source])).values()],
    sourceAnalysis: projected, batchPlan: { ...portfolioSnapshot(created).batchPlan, portfolioAudit: undefined } };
  await updateCreativePortfolio(created.id, job => finishPortfolioInitialPlan(job, 'plan', { plannerArgs, snapshot }, 2500), storage);
  const loaded = await readCreativePortfolio(created.id, storage);
  expect(loaded?.planning.phase).toBe('DIVERSITY_AUDIT');
  expect(JSON.stringify(loaded)).toContain(savedDependency.completed!.artifact.sha256);
  const failed = structuredClone(loaded!);
  failed.planningError = 'Explicit retry';
  if (failed.planning.phase !== 'DIVERSITY_AUDIT') throw new Error();
  failed.planning.repairAttempted = true;
  failed.planning.checkpoint.snapshot.batchPlan.portfolioAudit = portfolioAudit(2);
  const retried = retryPortfolioWork(failed, null, 3000);
  expect(retried.planning.phase === 'INITIAL_PLAN' && retried.planning.preparation.videoDependencies).toEqual([savedDependency]);
  const mismatch = structuredClone(loaded!);
  if (mismatch.planning.phase !== 'DIVERSITY_AUDIT') throw new Error();
  delete mismatch.planning.checkpoint.snapshot.sourceAnalysis;
  expect(() => parseCreativePortfolioJob(Buffer.from(JSON.stringify(mismatch)), mismatch.id)).toThrow('Saved creative portfolio is invalid');
});
