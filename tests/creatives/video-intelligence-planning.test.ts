import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { requestCreativeBatch } from '@/lib/ai/creative-planner';
import { projectCompletedVideoIntelligence, parseVideoPlanningContext,
  MAX_PLANNING_VIDEO_CONTEXT_BYTES, MAX_PLANNING_VIDEO_OBSERVATIONS,
  MAX_PLANNING_VIDEO_TRANSCRIPT_EXCERPTS, videoPlanningSelectorBinding } from '@/lib/creatives/video-intelligence-planning';
import { claimCreativePortfolio, finishPortfolioInitialPlan, newCreativePortfolio, retryPortfolioWork } from '@/lib/creatives/portfolio-job';
import { readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { parseCreativePortfolioJob } from '@/lib/creatives/portfolio-job-parser';
import { parsePlanningSourceAnalysis } from '@/lib/creatives/planning-source-parser';
import type { PlanningSourceAnalysisState, VideoPlanningContextV1,
  VideoPlanningContextV2, VideoPlanningContextV3 } from '@/lib/creatives/planning-source-packet';
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
const spreadLibrary = (source: ReturnType<typeof videoSource>) => {
  const value = library(source, 30);
  value.durationMs = 100_000;
  value.transcript.segments.forEach((segment, index) => {
    segment.startMs = index === 0 ? 0 : index === 1 ? 50_000 : 85_000 + (index - 2) * 500;
    segment.endMs = segment.startMs + 400;
    if (index === 1) segment.text = 'Outcome statement';
    if (index === 2) segment.text = 'Qualification that must stay adjacent';
  });
  value.representativeFrames.forEach((frame, index) => {
    frame.timestampMs = index === 0 ? 100 : index === 1 ? 50_100 : 85_100 + (index - 2) * 500;
    value.candidates[index].timestampMs = frame.timestampMs;
    frame.id = `video-frame:${hash(`${source.sha256}:${frame.timestampMs}:${frame.frameSha256}`)}`;
  });
  value.representativeFrames[1].transcriptSegments = [value.transcript.segments[1]];
  return value;
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
const plannedConcept = (index: number) => {
  const adCopy = { primaryText: `Primary ${index}`, headline: `Headline ${index}`, description: '' };
  return { index, format: 'educational', copy: adCopy, adCopy: { ...adCopy },
    imageCopy: { headline: `Headline ${index}`, cta: 'Talk with TRA' },
    selectionReason: `Reason ${index}`, strategy: { conceptDetails, category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Taxpayer',
      painPoint: 'Uncertainty', desiredOutcome: 'Clarity', emotion: 'Relief', hook: 'Understand options', cta: 'Talk with TRA', offer: null,
      soWhat: { surfaceMessage: `Message ${index}`, functionalConsequence: 'See options', meaningfulOutcome: 'Move forward' },
      execution: { taxDocumentReference: 'none', subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'minimal-graphic', textDensity: 'low',
        ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' }, visualDirection: 'Simple graphic' } };
};
const ok = () => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ creatives: [plannedConcept(1), plannedConcept(2)] }) }] }] }), { status: 200 });
const legacyContext = (source: ReturnType<typeof videoSource>, value = library(source, 30)): VideoPlanningContextV1 => {
  const saved = dependency(source), indexes = (total: number, limit: number) => Array.from({ length: Math.min(total, limit) }, (_, index) =>
    total <= limit ? index : Math.round(index * (total - 1) / (limit - 1)));
  const excerpts = indexes(value.transcript.segments.length, MAX_PLANNING_VIDEO_TRANSCRIPT_EXCERPTS).map(index => value.transcript.segments[index]);
  const observations = indexes(value.representativeFrames.length, MAX_PLANNING_VIDEO_OBSERVATIONS).map(representativeOrdinal => {
    const { id, timestampMs, frameSha256, evidenceStatus, observation, transcriptSegments } = value.representativeFrames[representativeOrdinal];
    return { representativeOrdinal, id, timestampMs, frameSha256, evidenceStatus, observation, transcriptSegments };
  });
  return { identity: saved.identity, locator: { version: 1, sourceVideoMediaId: source.mediaId, sourceVideoContentHash: source.sha256,
    analyzerFingerprintSha256: saved.identity.analyzerFingerprint.sha256 }, jobId: saved.jobId, artifact: saved.completed!.artifact,
    library: { id: value.id, version: value.version, durationMs: value.durationMs, analysisModels: value.analysisModels,
      providerEligible: false, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' },
    transcript: { status: 'AVAILABLE', model: 'whisper-1', language: 'en', totalSegmentCount: value.transcript.segments.length,
      coverage: excerpts.length === value.transcript.segments.length ? 'COMPLETE' : 'UNIFORM_TIMELINE_V1', excerpts },
    observationCoverage: { totalRepresentativeCount: value.representativeFrames.length,
      coverage: observations.length === value.representativeFrames.length ? 'COMPLETE' : 'UNIFORM_TIMELINE_V1' }, observations };
};

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('projects multiple completed libraries with explicit bounded timeline coverage and sends them beside layout data to Astra', async () => {
  const sources = [videoSource('a'), videoSource('b')], dependencies = sources.map(dependency);
  const projected = projectCompletedVideoIntelligence(baseState(sources), [
    { dependency: dependencies[0], library: spreadLibrary(sources[0]) }, { dependency: dependencies[1], library: library(sources[1], 1, true) }], 'customer outcome');
  expect(parsePlanningSourceAnalysis(projected, [...sources, projected.entries[2].source], true)).toEqual(projected);
  const intelligence = projected.entries.flatMap(entry => entry.result?.kind === 'VIDEO_INTELLIGENCE' ? [entry.result.intelligence as VideoPlanningContextV3] : []);
  expect(intelligence[0]).toMatchObject({ projectionVersion: 3, transcript: { totalSegmentCount: 30, coverage: 'BOUNDED_WINDOWS_V2' },
    observationCoverage: { totalRepresentativeCount: 30, coverage: 'ELAPSED_TIME_BUCKETS_V2', buckets: [
      { bucket: 'EARLY', availableCount: 1, includedCount: 1 }, { bucket: 'MIDDLE', availableCount: 1, includedCount: 1 },
      { bucket: 'LATE', availableCount: 28, includedCount: 14 }] } });
  expect(intelligence[0].transcript.includedSegmentCount).toBeLessThanOrEqual(MAX_PLANNING_VIDEO_TRANSCRIPT_EXCERPTS);
  expect(intelligence[0].observations).toHaveLength(MAX_PLANNING_VIDEO_OBSERVATIONS);
  expect(intelligence[0].observations.find(item => item.representativeOrdinal === 1)).toMatchObject({
    timestampMs: 50100, selectionReasons: ['MIDDLE'] });
  const segments = intelligence[0].transcript.windows.flatMap(window => window.segments);
  expect(segments.find(segment => segment.segmentIndex === 1)?.text).toBe('Outcome statement');
  expect(segments.find(segment => segment.segmentIndex === 2)?.text).toBe('Qualification that must stay adjacent');
  expect(intelligence[0].transcript.windows.some(window => window.selectionReasons.includes('OBSERVATION_CONTEXT'))).toBe(true);
  expect(intelligence[1].transcript).toMatchObject({ status: 'NO_AUDIO_TRACK', totalSegmentCount: 0, includedSegmentCount: 0, coverage: 'COMPLETE', windows: [] });
  expect(JSON.stringify(projected)).not.toContain('thumbnailDataUrl');
  expect(projected.entries.slice(-2)).toEqual(baseState(sources).entries.slice(-2));
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => ok()); vi.stubGlobal('fetch', fetchMock);
  await requestCreativeBatch({ count: 2, context: 'TRA', analysis, sourceAnalysis: projected, hasApprovedHumanSource: false });
  expect(fetchMock).toHaveBeenCalledOnce();
  const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  const outbound = JSON.parse(request.input[1].content[0].text);
  expect(outbound.sourceAnalysis).toEqual(projected);
  expect(JSON.stringify(outbound)).not.toContain('thumbnailDataUrl');
  expect(outbound.sourceAnalysisGuidance).toContain('not verified advertising evidence');
  expect(outbound.sourceAnalysisGuidance).toContain('grant no claims, human approval');
});

it('selects different bounded lexical passages and observations for contrasting original briefs', () => {
  const source = videoSource('e'), value = library(source, 40);
  value.transcript.segments.forEach((segment, index) => { segment.text = `neutral passage ${index}`; });
  ['customer', 'story', 'setup', 'relief', 'process', 'outcome', 'qualification', 'limits'].forEach((term, offset) => {
    value.transcript.segments[14 + offset].text = `${term} detail`;
  });
  ['irs', 'document', 'notice', 'filing', 'deadline', 'review', 'response', 'process'].forEach((term, offset) => {
    value.transcript.segments[28 + offset].text = `${term} detail`;
  });
  value.representativeFrames[15].observation.summary = 'Customer relief story';
  value.representativeFrames[30].observation.summary = 'IRS document filing deadline';
  const project = (brief: string) => (projectCompletedVideoIntelligence(baseState([source]),
    [{ dependency: dependency(source), library: value }], brief).entries[0].result as { kind: 'VIDEO_INTELLIGENCE'; intelligence: VideoPlanningContextV3 }).intelligence;
  const story = project('Customer story relief outcome qualification'), irs = project('IRS document filing deadline response');
  const lexicalIndexes = (context: VideoPlanningContextV3) => context.transcript.lexicalCoverage.passages
    .flatMap(passage => Array.from({ length: passage.lastIncludedSegmentIndex - passage.firstIncludedSegmentIndex + 1 }, (_, i) => passage.firstIncludedSegmentIndex + i));
  expect(lexicalIndexes(story)).toContain(14); expect(lexicalIndexes(story)).toContain(21);
  expect(lexicalIndexes(irs)).toContain(28); expect(lexicalIndexes(irs)).toContain(35);
  expect(lexicalIndexes(story)).not.toEqual(lexicalIndexes(irs));
  expect(story.observations.find(item => item.representativeOrdinal === 15)?.selectionReasons).toContain('CAMPAIGN_LEXICAL_MATCH');
  expect(irs.observations.find(item => item.representativeOrdinal === 30)?.selectionReasons).toContain('CAMPAIGN_LEXICAL_MATCH');
  for (const context of [story, irs]) {
    expect(context.transcript.includedSegmentCount).toBeLessThanOrEqual(24);
    expect(context.observations.length).toBeLessThanOrEqual(16);
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(MAX_PLANNING_VIDEO_CONTEXT_BYTES);
    for (const passage of context.transcript.lexicalCoverage.passages) {
      expect(passage.lastCoreSegmentIndex - passage.firstCoreSegmentIndex + 1).toBeLessThanOrEqual(8);
      expect(passage.firstIncludedSegmentIndex).toBe(Math.max(0, passage.firstCoreSegmentIndex - 1));
      expect(passage.lastIncludedSegmentIndex).toBe(Math.min(39, passage.lastCoreSegmentIndex + 1));
    }
  }
});

it('records lexical query and retrieval limits for empty, missed, synonym-only and truncated briefs', () => {
  const source = videoSource('f'), value = library(source, 30), project = (brief: string) =>
    (projectCompletedVideoIntelligence(baseState([source]), [{ dependency: dependency(source), library: value }], brief)
      .entries[0].result as { kind: 'VIDEO_INTELLIGENCE'; intelligence: VideoPlanningContextV3 }).intelligence;
  for (const brief of ['', 'the and of', 'offtopic', 'unique belated utterance']) {
    const context = project(brief);
    expect(context.transcript.lexicalCoverage).toMatchObject({ availablePositiveCandidateCount: 0, includedPositiveCandidateCount: 0,
      omittedPositiveCandidateCount: 0, truncated: false, passages: [] });
    expect(context.observationCoverage.lexicalCoverage).toMatchObject({ availablePositiveCandidateCount: 0, includedPositiveCandidateCount: 0 });
    expect(context.transcript.windows.some(window => window.selectionReasons.includes('EARLY'))).toBe(true);
  }
  const brief = Array.from({ length: 70 }, (_, index) => `term${index}`).join(' '), selector = project(brief).selector;
  expect(selector).toEqual(videoPlanningSelectorBinding(brief));
  expect(selector).toMatchObject({ eligibleTermCount: 70, includedTermCount: 64, omittedTermCount: 6 });
  expect(selector.queryTerms).toEqual(Array.from({ length: 64 }, (_, index) => `term${index}`));
  expect(videoPlanningSelectorBinding('CAFÉ cafe\u0301 税金')).toMatchObject({ queryTerms: ['café', '税金'], eligibleTermCount: 2 });
});

it('rolls back a ranked core and both guards as one unit when the byte budget cannot hold it', () => {
  const source = videoSource('9'), value = library(source, 60);
  for (const index of [9, 10, 11, 29, 30, 31, 49, 50, 51]) value.transcript.segments[index].text = 't'.repeat(4000);
  const terms = ['customer', 'story', 'setup', 'process', 'outcome', 'qualification', 'restriction', 'disclaimer'];
  terms.forEach((term, offset) => { value.transcript.segments[18 + offset].text = `${term} ${'x'.repeat(3980)}`; });
  const context = (projectCompletedVideoIntelligence(baseState([source]), [{ dependency: dependency(source), library: value }], terms.join(' '))
    .entries[0].result as { kind: 'VIDEO_INTELLIGENCE'; intelligence: VideoPlanningContextV3 }).intelligence;
  expect(context.transcript.lexicalCoverage.availablePositiveCandidateCount).toBeGreaterThan(0);
  expect(context.transcript.lexicalCoverage.omittedPositiveCandidateCount).toBeGreaterThan(0);
  expect(context.transcript.lexicalCoverage.passages).not.toContainEqual(expect.objectContaining({ firstCoreSegmentIndex: 18, lastCoreSegmentIndex: 25 }));
  for (const passage of context.transcript.lexicalCoverage.passages) {
    const indexes = new Set(context.transcript.windows.flatMap(window => window.segments.map(segment => segment.segmentIndex)));
    for (let index = passage.firstIncludedSegmentIndex; index <= passage.lastIncludedSegmentIndex; index++) expect(indexes.has(index)).toBe(true);
  }
});

it('rejects incomplete, mismatched, malformed and oversized completed projections without provider work', () => {
  const source = videoSource('a'), complete = dependency(source), full = library(source, 30);
  expect(() => projectCompletedVideoIntelligence(baseState([source]), [{ dependency: { ...complete, completed: undefined }, library: full }], 'brief')).toThrow();
  expect(() => projectCompletedVideoIntelligence(baseState([{ ...source, sha256: 'f'.repeat(64) }]), [{ dependency: complete, library: full }], 'brief')).toThrow();
  const projected = projectCompletedVideoIntelligence(baseState([source]), [{ dependency: complete, library: full }], 'brief');
  const context = (projected.entries[0].result as { kind: 'VIDEO_INTELLIGENCE'; intelligence: VideoPlanningContextV3 }).intelligence;
  const invalid = [
    { ...context, observations: [{ ...context.observations[0], transcriptSegments: [{}] }, ...context.observations.slice(1)] },
    { ...context, observations: [{ ...context.observations[0], id: `video-frame:${'f'.repeat(64)}` }, ...context.observations.slice(1)] },
    { ...context, observations: [context.observations[0], context.observations[0]] },
    { ...context, observationCoverage: { ...context.observationCoverage, buckets: context.observationCoverage.buckets.map((bucket, index) =>
      index === 0 ? { ...bucket, availableCount: bucket.availableCount + 1 } : bucket) } },
    { ...context, library: { ...context.library, analysisModels: { ...context.library.analysisModels, transcription: null } } },
    { ...context, selector: { ...context.selector, queryTerms: [12] } },
    { ...context, transcript: { ...context.transcript, lexicalCoverage: {
      ...context.transcript.lexicalCoverage, includedPositiveCandidateCount: context.transcript.lexicalCoverage.includedPositiveCandidateCount + 1 } } },
  ];
  for (const value of invalid) expect(() => parseVideoPlanningContext(value, { mediaId: source.mediaId, sha256: source.sha256 })).toThrow();
  const malformedWindow = structuredClone(context);
  malformedWindow.transcript.windows[0].lastSegmentIndex++;
  expect(() => parseVideoPlanningContext(malformedWindow, { mediaId: source.mediaId, sha256: source.sha256 })).toThrow();
  if (context.transcript.lexicalCoverage.passages[0]) {
    const nonAtomic = structuredClone(context);
    nonAtomic.transcript.lexicalCoverage.passages[0].firstIncludedSegmentIndex++;
    expect(() => parseVideoPlanningContext(nonAtomic, source)).toThrow();
  }
  const duplicateSegment = structuredClone(context);
  duplicateSegment.transcript.windows[0].segments.push(duplicateSegment.transcript.windows[0].segments[0]);
  expect(() => parseVideoPlanningContext(duplicateSegment, { mediaId: source.mediaId, sha256: source.sha256 })).toThrow();
  const hiddenObservationTranscript = structuredClone(context);
  hiddenObservationTranscript.observations[0].transcriptSegments = [full.transcript.segments.find(segment =>
    !context.transcript.windows.some(window => window.segments.some(included => included.segmentIndex === segment.segmentIndex)))!];
  expect(() => parseVideoPlanningContext(hiddenObservationTranscript, { mediaId: source.mediaId, sha256: source.sha256 })).toThrow();
  const erasedAvailableTranscript = structuredClone(context);
  erasedAvailableTranscript.transcript = { ...erasedAvailableTranscript.transcript,
    includedSegmentCount: 0, coverage: 'BOUNDED_WINDOWS_V2', windows: [] };
  erasedAvailableTranscript.observations = erasedAvailableTranscript.observations.map(observation => ({ ...observation, transcriptSegments: [] }));
  expect(() => parseVideoPlanningContext(erasedAvailableTranscript, { mediaId: source.mediaId, sha256: source.sha256 })).toThrow();
  const missingSeedNeighbors = structuredClone(context), isolated = full.transcript.segments[5];
  missingSeedNeighbors.transcript = { ...missingSeedNeighbors.transcript, includedSegmentCount: 1, coverage: 'BOUNDED_WINDOWS_V2',
    windows: [{ firstSegmentIndex: 5, lastSegmentIndex: 5, startMs: isolated.startMs, endMs: isolated.endMs,
      selectionReasons: ['EARLY'], segments: [isolated] }] };
  missingSeedNeighbors.observations = missingSeedNeighbors.observations.map(observation => ({ ...observation, transcriptSegments: [] }));
  expect(() => parseVideoPlanningContext(missingSeedNeighbors, { mediaId: source.mediaId, sha256: source.sha256 })).toThrow();
  const observationOnly = structuredClone(context), first = full.transcript.segments[0];
  observationOnly.transcript = { ...observationOnly.transcript, includedSegmentCount: 1, coverage: 'BOUNDED_WINDOWS_V2',
    windows: [{ firstSegmentIndex: 0, lastSegmentIndex: 0, startMs: first.startMs, endMs: first.endMs,
      selectionReasons: ['OBSERVATION_CONTEXT'], segments: [first] }] };
  observationOnly.observations = observationOnly.observations.map((observation, index) => ({ ...observation,
    transcriptSegments: index === 0 ? [first] : [] }));
  expect(() => parseVideoPlanningContext(observationOnly, { mediaId: source.mediaId, sha256: source.sha256 })).toThrow();
  const oversized = structuredClone(context);
  oversized.transcript.windows = oversized.transcript.windows.map(window => ({ ...window,
    segments: window.segments.map(segment => ({ ...segment, text: 'x'.repeat(4000) })) }));
  expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(MAX_PLANNING_VIDEO_CONTEXT_BYTES);
  expect(() => parseVideoPlanningContext(oversized, { mediaId: source.mediaId, sha256: source.sha256 })).toThrow();
  const boundary = projectCompletedVideoIntelligence(baseState([source]), [{ dependency: complete, library: library(source, 1) }], 'brief');
  const boundaryContext = (boundary.entries[0].result as { kind: 'VIDEO_INTELLIGENCE'; intelligence: VideoPlanningContextV2 }).intelligence;
  expect(parseVideoPlanningContext(boundaryContext, source)).toEqual(boundaryContext);
  const noSpeech = structuredClone(projectCompletedVideoIntelligence(baseState([source]), [
    { dependency: complete, library: library(source, 1, true) }], 'brief').entries[0].result as { kind: 'VIDEO_INTELLIGENCE'; intelligence: VideoPlanningContextV3 }).intelligence;
  noSpeech.library.analysisModels.transcription = 'whisper-1';
  noSpeech.transcript = { status: 'AVAILABLE', model: 'whisper-1', language: 'en', totalSegmentCount: 0,
    includedSegmentCount: 0, coverage: 'COMPLETE', windows: [], lexicalCoverage: noSpeech.transcript.lexicalCoverage };
  expect(parseVideoPlanningContext(noSpeech, source)).toEqual(noSpeech);
});

it('keeps mandatory elapsed-time coverage while dropping whole optional observations to fit the byte budget', () => {
  const source = videoSource('d'), value = spreadLibrary(source);
  for (const frame of value.representativeFrames) {
    frame.observation.summary = 's'.repeat(3500); frame.observation.composition = 'c'.repeat(3500);
  }
  const projected = projectCompletedVideoIntelligence(baseState([source]), [{ dependency: dependency(source), library: value }], 'brief');
  const context = (projected.entries[0].result as { kind: 'VIDEO_INTELLIGENCE'; intelligence: VideoPlanningContextV3 }).intelligence;
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(MAX_PLANNING_VIDEO_CONTEXT_BYTES);
  expect(context.observations.length).toBeLessThan(MAX_PLANNING_VIDEO_OBSERVATIONS);
  expect(context.observationCoverage.buckets.every(bucket => bucket.availableCount === 0 || bucket.includedCount > 0)).toBe(true);
  const impossible = spreadLibrary(source);
  for (const frame of impossible.representativeFrames) frame.observation.visibleText = Array(20).fill('x'.repeat(4000));
  expect(() => projectCompletedVideoIntelligence(baseState([source]), [{ dependency: dependency(source), library: impossible }], 'brief')).toThrow();
});

it('dispatches legacy v1 exactly and preserves completed v1 and v2 projections during mixed repeated projection', () => {
  const oldSource = videoSource('a'), newSource = videoSource('b'), oldLibrary = library(oldSource, 30);
  const legacy = legacyContext(oldSource, oldLibrary);
  expect(parseVideoPlanningContext(legacy, oldSource)).toEqual(legacy);
  expect('projectionVersion' in parseVideoPlanningContext(legacy, oldSource)).toBe(false);
  const generatedV3 = (projectCompletedVideoIntelligence(baseState([newSource]), [{ dependency: dependency(newSource), library: library(newSource, 3) }], '')
    .entries[0].result as { kind: 'VIDEO_INTELLIGENCE'; intelligence: VideoPlanningContextV3 }).intelligence;
  const savedV2 = structuredClone(generatedV3) as any;
  savedV2.projectionVersion = 2; delete savedV2.selector; delete savedV2.transcript.lexicalCoverage; delete savedV2.observationCoverage.lexicalCoverage;
  expect(parseVideoPlanningContext(savedV2, newSource)).toEqual(savedV2);
  const invalidV2 = structuredClone(savedV2);
  invalidV2.observations[0].selectionReasons.push('CAMPAIGN_LEXICAL_MATCH');
  expect(() => parseVideoPlanningContext(invalidV2, newSource)).toThrow();
  const state = baseState([oldSource, newSource]);
  state.entries[0] = { source: oldSource, analyzer: { kind: 'VIDEO_INTELLIGENCE', model: 'vision-model', schemaVersion: 1, contextSha256: null },
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', result: { kind: 'VIDEO_INTELLIGENCE', intelligence: legacy } };
  const mixed = projectCompletedVideoIntelligence(state, [
    { dependency: dependency(oldSource), library: oldLibrary }, { dependency: dependency(newSource), library: library(newSource, 3) }], 'brief');
  expect(mixed.entries[0]).toEqual(state.entries[0]);
  mixed.entries[1] = { ...mixed.entries[1], result: { kind: 'VIDEO_INTELLIGENCE', intelligence: savedV2 } };
  expect((mixed.entries[1].result as { kind: 'VIDEO_INTELLIGENCE'; intelligence: VideoPlanningContextV2 }).intelligence.projectionVersion).toBe(2);
  const repeated = projectCompletedVideoIntelligence(mixed, [
    { dependency: dependency(oldSource), library: oldLibrary }, { dependency: dependency(newSource), library: library(newSource, 3) }], 'changed brief');
  expect(repeated).toEqual(mixed);
  expect(JSON.stringify(repeated)).toBe(JSON.stringify(mixed));
});

it('preserves exact completed dependencies through the real initial-plan checkpoint and parser reload', async () => {
  const source = videoSource('a'), savedDependency = dependency(source);
  const projected = projectCompletedVideoIntelligence(baseState([source]), [{ dependency: savedDependency, library: library(source, 2) }], 'TRA');
  const request = { context: 'TRA', placement: 'SQUARE_1_1' as const, variationCount: 2,
    sourceAssets: [...new Map(projected.entries.map(entry => [entry.source.mediaId, { role: entry.source.role, mediaId: entry.source.mediaId }])).values()] };
  const created = { ...newCreativePortfolio(request, 1000), videoPreparationVersion: 1 as const };
  if (created.planning.phase !== 'INITIAL_PLAN') throw new Error();
  created.planning.preparation = { quotaReserved: true, videoDependencies: [savedDependency] };
  const badPreparation = structuredClone(created);
  if (badPreparation.planning.phase !== 'INITIAL_PLAN') throw new Error();
  badPreparation.planning.preparation.sourceAnalysis = structuredClone(projected);
  const preparationContext = badPreparation.planning.preparation.sourceAnalysis.entries[0].result as { kind: 'VIDEO_INTELLIGENCE'; intelligence: VideoPlanningContextV3 };
  preparationContext.intelligence.selector = videoPlanningSelectorBinding('different direction');
  expect(() => parseCreativePortfolioJob(Buffer.from(JSON.stringify(badPreparation)), badPreparation.id)).toThrow('Saved creative portfolio is invalid');
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
  const selectorMismatch = structuredClone(loaded!);
  if (selectorMismatch.planning.phase !== 'DIVERSITY_AUDIT') throw new Error();
  for (const state of [selectorMismatch.planning.checkpoint.plannerArgs.sourceAnalysis!, selectorMismatch.planning.checkpoint.snapshot.sourceAnalysis!]) {
    const result = state.entries[0].result as { kind: 'VIDEO_INTELLIGENCE'; intelligence: VideoPlanningContextV3 };
    result.intelligence.selector = videoPlanningSelectorBinding('different direction');
  }
  expect(() => parseCreativePortfolioJob(Buffer.from(JSON.stringify(selectorMismatch)), selectorMismatch.id)).toThrow('Saved creative portfolio is invalid');
});