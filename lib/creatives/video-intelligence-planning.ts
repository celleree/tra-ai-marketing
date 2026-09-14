import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PlanningSourceAnalysisState, VideoPlanningContext } from '@/lib/creatives/planning-source-packet';
import { parsePortfolioVideoDependencies, type PortfolioVideoDependency } from '@/lib/creatives/portfolio-video-dependency';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { videoIntelligenceJobId } from '@/lib/video/intelligence-job';
import { normalizePersistedVideoFrameLibrary } from '@/lib/video/library-service';
import { parseFrameVisualObservation } from '@/lib/video/visual-observation';

export const MAX_PLANNING_VIDEO_TRANSCRIPT_EXCERPTS = 24;
export const MAX_PLANNING_VIDEO_OBSERVATIONS = 16;
export const MAX_PLANNING_VIDEO_CONTEXT_BYTES = 64 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const FRAME = /^video-frame:[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && names.every(name => name in value);
const safe = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const boundedText = (value: unknown, max = 4000) => typeof value === 'string' && value.length <= max;
const fail = (): never => { throw new Error('Invalid completed video intelligence planning context.'); };
const frameId = (sourceHash: string, timestampMs: number, frameHash: string) =>
  `video-frame:${createHash('sha256').update(`${sourceHash}:${timestampMs}:${frameHash}`).digest('hex')}`;
const validSegment = (segment: unknown, durationMs: number, total: number) => {
  if (!record(segment) || !exact(segment, ['segmentIndex', 'startMs', 'endMs', 'text'])) return false;
  const { segmentIndex, startMs, endMs, text } = segment;
  return safe(segmentIndex) && segmentIndex < total && safe(startMs) && safe(endMs)
    && endMs > startMs && endMs <= durationMs && boundedText(text, 4000);
};

const uniformlyBound = <T>(values: readonly T[], limit: number) => {
  if (values.length <= limit) return [...values];
  return Array.from({ length: limit }, (_, index) => values[Math.round(index * (values.length - 1) / (limit - 1))]);
};

export function parseVideoPlanningContext(value: unknown, source: { mediaId: string; sha256: string }): VideoPlanningContext {
  if (!record(value) || !exact(value, ['identity', 'locator', 'jobId', 'artifact', 'library', 'transcript', 'observationCoverage', 'observations'])
    || !record(value.identity) || !record(value.locator) || !record(value.artifact) || !record(value.library)
    || !record(value.transcript) || !record(value.observationCoverage) || !Array.isArray(value.observations)
    || Buffer.byteLength(JSON.stringify(value)) > MAX_PLANNING_VIDEO_CONTEXT_BYTES) return fail();
  const context = value as unknown as VideoPlanningContext;
  const dependency = parsePortfolioVideoDependencies([{ version: 1, identity: context.identity, jobId: context.jobId,
    completed: { artifact: context.artifact, library: { id: context.library.id, version: context.library.version } } }],
  [{ mediaId: source.mediaId, role: 'TRA_VIDEO' }])[0];
  if (!exact(value.locator, ['version', 'sourceVideoMediaId', 'sourceVideoContentHash', 'analyzerFingerprintSha256'])
    || context.locator.version !== 1 || context.locator.sourceVideoMediaId !== source.mediaId
    || context.locator.sourceVideoContentHash !== source.sha256
    || context.locator.analyzerFingerprintSha256 !== dependency.identity.analyzerFingerprint.sha256
    || context.identity.sourceVideoContentHash !== source.sha256 || context.jobId !== videoIntelligenceJobId(context.identity)
    || !exact(value.library, ['id', 'version', 'durationMs', 'analysisModels', 'providerEligible', 'evidenceStatus'])
    || !safe(context.library.durationMs) || context.library.durationMs < 1 || !record(context.library.analysisModels)
    || !exact(context.library.analysisModels as unknown as Record<string, unknown>, ['transcription', 'vision'])
    || !Array.isArray(context.library.analysisModels.vision) || context.library.analysisModels.vision.length !== 1
    || context.library.analysisModels.vision[0] !== context.identity.analyzerFingerprint.visionModel
    || context.library.providerEligible !== false || context.library.evidenceStatus !== 'UNVERIFIED_MODEL_OBSERVATION') return fail();
  const transcript = context.transcript;
  if (!exact(value.transcript, ['status', 'model', 'language', 'totalSegmentCount', 'coverage', 'excerpts'])
    || !safe(transcript.totalSegmentCount) || !Array.isArray(transcript.excerpts)
    || transcript.excerpts.length > MAX_PLANNING_VIDEO_TRANSCRIPT_EXCERPTS || transcript.excerpts.length > transcript.totalSegmentCount
    || transcript.coverage !== (transcript.excerpts.length === transcript.totalSegmentCount ? 'COMPLETE' : 'UNIFORM_TIMELINE_V1')
    || (transcript.status === 'NO_AUDIO_TRACK'
      ? transcript.model !== null || transcript.language !== null || transcript.totalSegmentCount !== 0
        || context.library.analysisModels.transcription !== null
      : transcript.status !== 'AVAILABLE' || transcript.model !== 'whisper-1'
        || context.library.analysisModels.transcription !== transcript.model || !boundedText(transcript.language, 100))) return fail();
  let previousSegment = -1;
  for (const segment of transcript.excerpts) {
    if (!validSegment(segment, context.library.durationMs, transcript.totalSegmentCount)
      || segment.segmentIndex <= previousSegment) return fail();
    previousSegment = segment.segmentIndex;
  }
  const coverage = context.observationCoverage;
  if (!exact(value.observationCoverage, ['totalRepresentativeCount', 'coverage']) || !safe(coverage.totalRepresentativeCount)
    || context.observations.length > MAX_PLANNING_VIDEO_OBSERVATIONS || context.observations.length > coverage.totalRepresentativeCount
    || coverage.coverage !== (context.observations.length === coverage.totalRepresentativeCount ? 'COMPLETE' : 'UNIFORM_TIMELINE_V1')) return fail();
  if (coverage.totalRepresentativeCount < 1 || context.observations.length < 1) return fail();
  let previousTimestamp = -1;
  const observationIds = new Set<string>();
  for (const observation of context.observations) {
    if (!record(observation) || !exact(observation, ['id', 'timestampMs', 'frameSha256', 'evidenceStatus', 'observation', 'transcriptSegments'])
      || typeof observation.id !== 'string' || !FRAME.test(observation.id) || !safe(observation.timestampMs)
      || observation.timestampMs > context.library.durationMs || observation.timestampMs < previousTimestamp
      || typeof observation.frameSha256 !== 'string' || !SHA.test(observation.frameSha256)
      || observation.id !== frameId(source.sha256, observation.timestampMs, observation.frameSha256)
      || observationIds.has(observation.id) || observation.evidenceStatus !== 'UNVERIFIED_MODEL_OBSERVATION'
      || !Array.isArray(observation.transcriptSegments) || observation.transcriptSegments.length > 20) return fail();
    let prior = -1;
    for (const segment of observation.transcriptSegments) {
      if (!validSegment(segment, context.library.durationMs, transcript.totalSegmentCount)
        || segment.segmentIndex <= prior || segment.startMs > observation.timestampMs || segment.endMs <= observation.timestampMs) return fail();
      prior = segment.segmentIndex;
    }
    parseFrameVisualObservation(observation.observation);
    observationIds.add(observation.id); previousTimestamp = observation.timestampMs;
  }
  return structuredClone(context);
}

export function projectCompletedVideoIntelligence(
  state: PlanningSourceAnalysisState,
  completed: Array<{ dependency: PortfolioVideoDependency; library: VideoFrameLibrary }>,
): PlanningSourceAnalysisState {
  const videos = state.entries.filter(entry => entry.source.role === 'TRA_VIDEO');
  if (videos.length !== completed.length || new Set(videos.map(entry => entry.source.mediaId)).size !== videos.length
    || new Set(completed.map(item => item.dependency.identity.sourceVideoMediaId)).size !== completed.length) return fail();
  const replacements = new Map(completed.map(({ dependency, library: raw }) => {
    if (!dependency.completed) return fail();
    const matching = videos.find(entry => entry.source.mediaId === dependency.identity.sourceVideoMediaId);
    if (!matching || matching.source.sha256 !== dependency.identity.sourceVideoContentHash) return fail();
    const [saved] = parsePortfolioVideoDependencies([dependency], videos.map(entry => entry.source));
    const library = normalizePersistedVideoFrameLibrary(raw, saved.identity.sourceVideoMediaId, saved.identity.sourceVideoContentHash);
    if (!library || library.analysisModels.vision.length !== 1
      || library.analysisModels.vision[0] !== saved.identity.analyzerFingerprint.visionModel
      || !isDeepStrictEqual(saved.completed!.library, { id: library.id, version: library.version })) return fail();
    const excerpts = uniformlyBound(library.transcript.segments, MAX_PLANNING_VIDEO_TRANSCRIPT_EXCERPTS);
    const observations = uniformlyBound(library.representativeFrames, MAX_PLANNING_VIDEO_OBSERVATIONS)
      .map(({ id, timestampMs, frameSha256, evidenceStatus, observation, transcriptSegments }) =>
        ({ id, timestampMs, frameSha256, evidenceStatus, observation, transcriptSegments }));
    const intelligence: VideoPlanningContext = {
      identity: saved.identity,
      locator: { version: 1, sourceVideoMediaId: saved.identity.sourceVideoMediaId,
        sourceVideoContentHash: saved.identity.sourceVideoContentHash,
        analyzerFingerprintSha256: saved.identity.analyzerFingerprint.sha256 },
      jobId: saved.jobId, artifact: saved.completed!.artifact,
      library: { id: library.id, version: library.version, durationMs: library.durationMs,
        analysisModels: library.analysisModels, providerEligible: false, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' },
      transcript: { status: library.transcript.status === 'SKIPPED_NO_AUDIO_TRACK' ? 'NO_AUDIO_TRACK' : 'AVAILABLE',
        model: library.transcript.model, language: library.transcript.language, totalSegmentCount: library.transcript.segments.length,
        coverage: excerpts.length === library.transcript.segments.length ? 'COMPLETE' : 'UNIFORM_TIMELINE_V1', excerpts },
      observationCoverage: { totalRepresentativeCount: library.representativeFrames.length,
        coverage: observations.length === library.representativeFrames.length ? 'COMPLETE' : 'UNIFORM_TIMELINE_V1' },
      observations,
    };
    parseVideoPlanningContext(intelligence, { mediaId: saved.identity.sourceVideoMediaId, sha256: saved.identity.sourceVideoContentHash });
    return [saved.identity.sourceVideoMediaId, intelligence] as const;
  }));
  return { version: 1, entries: state.entries.map(entry => {
    if (entry.source.role !== 'TRA_VIDEO') return structuredClone(entry);
    const intelligence = replacements.get(entry.source.mediaId);
    if (!intelligence || (entry.analyzer.kind !== 'REPRESENTATIVE_VIDEO_FRAMES' && entry.analyzer.kind !== 'VIDEO_INTELLIGENCE')) return fail();
    return { source: structuredClone(entry.source), analyzer: { kind: 'VIDEO_INTELLIGENCE' as const,
      model: intelligence.identity.analyzerFingerprint.visionModel, schemaVersion: 1 as const, contextSha256: null },
      evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const,
      result: { kind: 'VIDEO_INTELLIGENCE' as const, intelligence } };
  }) };
}

export function videoDependenciesFromPlanningSourceAnalysis(state: PlanningSourceAnalysisState | undefined) {
  return state?.entries.flatMap(entry => entry.result?.kind === 'VIDEO_INTELLIGENCE'
    ? [{ version: 1 as const, identity: entry.result.intelligence.identity, jobId: entry.result.intelligence.jobId,
      completed: { artifact: entry.result.intelligence.artifact,
        library: { id: entry.result.intelligence.library.id, version: entry.result.intelligence.library.version } } }]
    : []) ?? [];
}
