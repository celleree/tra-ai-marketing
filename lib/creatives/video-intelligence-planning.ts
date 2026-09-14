import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PlanningSourceAnalysisState, VideoPlanningContext, VideoPlanningContextV1,
  VideoPlanningContextV2, VideoPlanningSelectionReason, VideoPlanningTimeBucket } from '@/lib/creatives/planning-source-packet';
import { parsePortfolioVideoDependencies, type PortfolioVideoDependency } from '@/lib/creatives/portfolio-video-dependency';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { videoIntelligenceJobId } from '@/lib/video/intelligence-job';
import { normalizePersistedVideoFrameLibrary } from '@/lib/video/library-service';
import { parseFrameVisualObservation } from '@/lib/video/visual-observation';
import type { VideoTranscriptSegment } from '@/lib/video/transcript';

export const MAX_PLANNING_VIDEO_TRANSCRIPT_EXCERPTS = 24;
export const MAX_PLANNING_VIDEO_OBSERVATIONS = 16;
export const MAX_PLANNING_VIDEO_CONTEXT_BYTES = 64 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const FRAME = /^video-frame:[a-f0-9]{64}$/;
const BUCKETS = ['EARLY', 'MIDDLE', 'LATE'] as const;
const REASONS = [...BUCKETS, 'OBSERVATION_CONTEXT'] as const;
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
const uniformIndexes = (total: number, limit: number) => Array.from({ length: Math.min(total, limit) }, (_, index) =>
  total <= limit ? index : Math.round(index * (total - 1) / (limit - 1)));
const timeBucket = (timestampMs: number, durationMs: number): VideoPlanningTimeBucket =>
  timestampMs * 3 < durationMs ? 'EARLY' : timestampMs * 3 < durationMs * 2 ? 'MIDDLE' : 'LATE';
const orderedReasons = (reasons: Iterable<VideoPlanningSelectionReason>) => {
  const values = new Set(reasons);
  return REASONS.filter(reason => values.has(reason));
};

const validateCommon = (value: Record<string, unknown>, context: VideoPlanningContext,
  source: { mediaId: string; sha256: string }) => {
  if (!record(value.identity) || !record(value.locator) || !record(value.artifact) || !record(value.library)
    || !record(value.transcript) || !record(value.observationCoverage) || !Array.isArray(value.observations)
    || Buffer.byteLength(JSON.stringify(value)) > MAX_PLANNING_VIDEO_CONTEXT_BYTES) return fail();
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
};

const validateTranscriptHeader = (transcript: VideoPlanningContext['transcript'], library: VideoPlanningContext['library']) => {
  if (!safe(transcript.totalSegmentCount) || (transcript.status === 'NO_AUDIO_TRACK'
    ? transcript.model !== null || transcript.language !== null || transcript.totalSegmentCount !== 0
      || library.analysisModels.transcription !== null
    : transcript.status !== 'AVAILABLE' || transcript.model !== 'whisper-1'
      || library.analysisModels.transcription !== transcript.model || !boundedText(transcript.language, 100))) return fail();
};

const validateObservation = (observation: Record<string, unknown>, context: VideoPlanningContext,
  source: { sha256: string }, transcriptTotal: number) => {
  if (typeof observation.id !== 'string' || !FRAME.test(observation.id) || !safe(observation.representativeOrdinal)
    || !safe(observation.timestampMs) || observation.timestampMs > context.library.durationMs
    || typeof observation.frameSha256 !== 'string' || !SHA.test(observation.frameSha256)
    || observation.id !== frameId(source.sha256, observation.timestampMs, observation.frameSha256)
    || observation.evidenceStatus !== 'UNVERIFIED_MODEL_OBSERVATION'
    || !Array.isArray(observation.transcriptSegments) || observation.transcriptSegments.length > 20) return fail();
  let prior = -1;
  for (const segment of observation.transcriptSegments) {
    if (!validSegment(segment, context.library.durationMs, transcriptTotal)
      || segment.segmentIndex <= prior || segment.startMs > observation.timestampMs || segment.endMs <= observation.timestampMs) return fail();
    prior = segment.segmentIndex;
  }
  parseFrameVisualObservation(observation.observation);
};

const parseV1 = (value: Record<string, unknown>, context: VideoPlanningContextV1, source: { mediaId: string; sha256: string }) => {
  if (!exact(value, ['identity', 'locator', 'jobId', 'artifact', 'library', 'transcript', 'observationCoverage', 'observations'])) return fail();
  validateCommon(value, context, source);
  const transcript = context.transcript;
  if (!exact(value.transcript as Record<string, unknown>, ['status', 'model', 'language', 'totalSegmentCount', 'coverage', 'excerpts'])
    || !Array.isArray(transcript.excerpts)
    || transcript.excerpts.length !== Math.min(transcript.totalSegmentCount, MAX_PLANNING_VIDEO_TRANSCRIPT_EXCERPTS)
    || transcript.coverage !== (transcript.excerpts.length === transcript.totalSegmentCount ? 'COMPLETE' : 'UNIFORM_TIMELINE_V1')) return fail();
  validateTranscriptHeader(transcript, context.library);
  let previousSegment = -1, previousStart = -1;
  const transcriptIndexes = uniformIndexes(transcript.totalSegmentCount, MAX_PLANNING_VIDEO_TRANSCRIPT_EXCERPTS);
  for (const [index, segment] of transcript.excerpts.entries()) {
    if (!validSegment(segment, context.library.durationMs, transcript.totalSegmentCount)
      || segment.segmentIndex !== transcriptIndexes[index] || segment.segmentIndex <= previousSegment
      || segment.startMs < previousStart) return fail();
    previousSegment = segment.segmentIndex; previousStart = segment.startMs;
  }
  const coverage = context.observationCoverage;
  if (!exact(value.observationCoverage as Record<string, unknown>, ['totalRepresentativeCount', 'coverage'])
    || !safe(coverage.totalRepresentativeCount)
    || context.observations.length !== Math.min(coverage.totalRepresentativeCount, MAX_PLANNING_VIDEO_OBSERVATIONS)
    || coverage.coverage !== (context.observations.length === coverage.totalRepresentativeCount ? 'COMPLETE' : 'UNIFORM_TIMELINE_V1')
    || coverage.totalRepresentativeCount < 1 || context.observations.length < 1) return fail();
  let previousTimestamp = -1;
  const ids = new Set<string>();
  const indexes = uniformIndexes(coverage.totalRepresentativeCount, MAX_PLANNING_VIDEO_OBSERVATIONS);
  for (const [index, observation] of context.observations.entries()) {
    if (!record(observation) || !exact(observation, ['representativeOrdinal', 'id', 'timestampMs', 'frameSha256', 'evidenceStatus', 'observation', 'transcriptSegments'])
      || observation.representativeOrdinal !== indexes[index] || observation.timestampMs < previousTimestamp || ids.has(observation.id)) return fail();
    validateObservation(observation, context, source, transcript.totalSegmentCount);
    ids.add(observation.id); previousTimestamp = observation.timestampMs;
  }
};

const parseV2 = (value: Record<string, unknown>, context: VideoPlanningContextV2, source: { mediaId: string; sha256: string }) => {
  if (!exact(value, ['projectionVersion', 'identity', 'locator', 'jobId', 'artifact', 'library', 'transcript', 'observationCoverage', 'observations'])
    || context.projectionVersion !== 2) return fail();
  validateCommon(value, context, source);
  const transcript = context.transcript;
  if (!exact(value.transcript as Record<string, unknown>, ['status', 'model', 'language', 'totalSegmentCount', 'includedSegmentCount', 'coverage', 'windows'])
    || !safe(transcript.includedSegmentCount) || transcript.includedSegmentCount > MAX_PLANNING_VIDEO_TRANSCRIPT_EXCERPTS
    || !Array.isArray(transcript.windows)
    || transcript.coverage !== (transcript.includedSegmentCount === transcript.totalSegmentCount ? 'COMPLETE' : 'BOUNDED_WINDOWS_V2')) return fail();
  validateTranscriptHeader(transcript, context.library);
  const included = new Map<number, unknown>();
  const observationContextIndexes = new Set<number>();
  let previousLast = -2, previousStart = -1, previousSegmentStart = -1;
  for (const window of transcript.windows) {
    if (!record(window) || !exact(window, ['firstSegmentIndex', 'lastSegmentIndex', 'startMs', 'endMs', 'selectionReasons', 'segments'])
      || !safe(window.firstSegmentIndex) || !safe(window.lastSegmentIndex) || window.lastSegmentIndex < window.firstSegmentIndex
      || !safe(window.startMs) || !safe(window.endMs) || window.endMs <= window.startMs || window.startMs < previousStart
      || window.firstSegmentIndex <= previousLast + 1 || !Array.isArray(window.selectionReasons) || window.selectionReasons.length < 1
      || !isDeepStrictEqual(window.selectionReasons, orderedReasons(window.selectionReasons as VideoPlanningSelectionReason[]))
      || !Array.isArray(window.segments) || window.segments.length !== window.lastSegmentIndex - window.firstSegmentIndex + 1) return fail();
    for (const [offset, segment] of window.segments.entries()) {
      if (!validSegment(segment, context.library.durationMs, transcript.totalSegmentCount)
        || segment.segmentIndex !== window.firstSegmentIndex + offset || segment.startMs < previousSegmentStart
        || included.has(segment.segmentIndex)) return fail();
      included.set(segment.segmentIndex, segment);
      previousSegmentStart = segment.startMs;
    }
    if (window.segments[0]?.startMs !== window.startMs || window.segments.at(-1)?.endMs !== window.endMs) return fail();
    for (const reason of window.selectionReasons) {
      if (!REASONS.includes(reason as VideoPlanningSelectionReason)
        || (reason !== 'OBSERVATION_CONTEXT' && !window.segments.some(segment => timeBucket(segment.startMs, context.library.durationMs) === reason))) return fail();
    }
    if (window.selectionReasons.includes('OBSERVATION_CONTEXT')) {
      for (const segment of window.segments) observationContextIndexes.add(segment.segmentIndex);
    }
    previousLast = window.lastSegmentIndex; previousStart = window.startMs;
  }
  if (included.size !== transcript.includedSegmentCount || (transcript.status === 'NO_AUDIO_TRACK' && transcript.windows.length !== 0)) return fail();
  const coverage = context.observationCoverage;
  if (!exact(value.observationCoverage as Record<string, unknown>, ['totalRepresentativeCount', 'coverage', 'buckets'])
    || !safe(coverage.totalRepresentativeCount) || coverage.totalRepresentativeCount < 1 || context.observations.length < 1
    || context.observations.length > MAX_PLANNING_VIDEO_OBSERVATIONS || !Array.isArray(coverage.buckets) || coverage.buckets.length !== BUCKETS.length
    || coverage.coverage !== (context.observations.length === coverage.totalRepresentativeCount ? 'COMPLETE' : 'ELAPSED_TIME_BUCKETS_V2')) return fail();
  let availableTotal = 0, includedTotal = 0;
  for (const [index, bucket] of coverage.buckets.entries()) {
    if (!record(bucket) || !exact(bucket, ['bucket', 'availableCount', 'includedCount']) || bucket.bucket !== BUCKETS[index]
      || !safe(bucket.availableCount) || !safe(bucket.includedCount) || bucket.includedCount > bucket.availableCount
      || (bucket.availableCount > 0 && bucket.includedCount < 1)) return fail();
    availableTotal += bucket.availableCount; includedTotal += bucket.includedCount;
  }
  if (availableTotal !== coverage.totalRepresentativeCount || includedTotal !== context.observations.length) return fail();
  let previousTimestamp = -1, previousOrdinal = -1;
  const ids = new Set<string>(), ordinals = new Set<number>(), actualIncluded = new Map(BUCKETS.map(bucket => [bucket, 0]));
  const observationSegmentIndexes = new Set<number>();
  for (const observation of context.observations) {
    if (!record(observation) || !exact(observation, ['representativeOrdinal', 'id', 'timestampMs', 'frameSha256', 'evidenceStatus', 'observation', 'transcriptSegments', 'selectionReasons'])
      || !Array.isArray(observation.selectionReasons) || observation.selectionReasons.length !== 1
      || observation.selectionReasons[0] !== timeBucket(observation.timestampMs as number, context.library.durationMs)
      || observation.representativeOrdinal >= coverage.totalRepresentativeCount || observation.representativeOrdinal <= previousOrdinal
      || observation.timestampMs < previousTimestamp || ids.has(observation.id) || ordinals.has(observation.representativeOrdinal)) return fail();
    validateObservation(observation, context, source, transcript.totalSegmentCount);
    for (const segment of observation.transcriptSegments) {
      if (!observationContextIndexes.has(segment.segmentIndex) || !isDeepStrictEqual(included.get(segment.segmentIndex), segment)) return fail();
      observationSegmentIndexes.add(segment.segmentIndex);
    }
    const bucket = observation.selectionReasons[0] as VideoPlanningTimeBucket;
    actualIncluded.set(bucket, actualIncluded.get(bucket)! + 1);
    ids.add(observation.id); ordinals.add(observation.representativeOrdinal); previousTimestamp = observation.timestampMs as number;
    previousOrdinal = observation.representativeOrdinal;
  }
  if (coverage.buckets.some(bucket => bucket.includedCount !== actualIncluded.get(bucket.bucket))) return fail();
  if (transcript.windows.some(window => window.selectionReasons.includes('OBSERVATION_CONTEXT')
    && !window.segments.some(segment => observationSegmentIndexes.has(segment.segmentIndex)))) return fail();
};

export function parseVideoPlanningContext(value: unknown, source: { mediaId: string; sha256: string }): VideoPlanningContext {
  if (!record(value)) return fail();
  const context = value as unknown as VideoPlanningContext;
  if ('projectionVersion' in value) parseV2(value, context as VideoPlanningContextV2, source);
  else parseV1(value, context as VideoPlanningContextV1, source);
  return structuredClone(context);
}

type Segment = VideoTranscriptSegment;
type V2Observation = VideoPlanningContextV2['observations'][number];
const buildTranscriptWindows = (segments: Segment[], selected: Map<number, Set<VideoPlanningSelectionReason>>) => {
  const windows: VideoPlanningContextV2['transcript']['windows'] = [];
  for (const index of [...selected.keys()].sort((a, b) => a - b)) {
    const reasons = selected.get(index)!;
    const previous = windows.at(-1);
    if (previous && previous.lastSegmentIndex + 1 === index) {
      previous.lastSegmentIndex = index; previous.endMs = segments[index].endMs;
      previous.segments.push(segments[index]); previous.selectionReasons = orderedReasons([...previous.selectionReasons, ...reasons]);
    } else windows.push({ firstSegmentIndex: index, lastSegmentIndex: index, startMs: segments[index].startMs,
      endMs: segments[index].endMs, selectionReasons: orderedReasons(reasons), segments: [segments[index]] });
  }
  return windows;
};

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
    if (matching.result?.kind === 'VIDEO_INTELLIGENCE') {
      const preserved = parseVideoPlanningContext(matching.result.intelligence, matching.source);
      if (!isDeepStrictEqual(videoDependenciesFromPlanningSourceAnalysis({ version: 1, entries: [matching] })[0], saved)) return fail();
      return [saved.identity.sourceVideoMediaId, preserved] as const;
    }
    const availableByBucket = new Map(BUCKETS.map(bucket => [bucket, [] as number[]]));
    library.representativeFrames.forEach((frame, index) => availableByBucket.get(timeBucket(frame.timestampMs, library.durationMs))!.push(index));
    const selectedObservationIndexes = new Set<number>();
    for (const bucket of BUCKETS) if (availableByBucket.get(bucket)!.length) selectedObservationIndexes.add(availableByBucket.get(bucket)![0]);
    const optionalObservationIndexes = [...new Set([
      ...uniformIndexes(library.representativeFrames.length, MAX_PLANNING_VIDEO_OBSERVATIONS),
      ...library.representativeFrames.map((_, index) => index),
    ])].filter(index => !selectedObservationIndexes.has(index));
    const selectedSegments = new Map<number, Set<VideoPlanningSelectionReason>>();
    const addNeighborhood = (seed: number, reason: VideoPlanningSelectionReason, mandatory: boolean) => {
      const indexes = [seed - 1, seed, seed + 1].filter(index => index >= 0 && index < library.transcript.segments.length);
      const additional = indexes.filter(index => !selectedSegments.has(index)).length;
      if (selectedSegments.size + additional > MAX_PLANNING_VIDEO_TRANSCRIPT_EXCERPTS) {
        if (mandatory) return fail();
        return false;
      }
      for (const index of indexes) {
        const reasons = selectedSegments.get(index) ?? new Set<VideoPlanningSelectionReason>();
        reasons.add(reason); selectedSegments.set(index, reasons);
      }
      return true;
    };
    for (const bucket of BUCKETS) {
      const candidates = library.transcript.segments.filter(segment => timeBucket(segment.startMs, library.durationMs) === bucket);
      if (!candidates.length) continue;
      const target = library.durationMs * (BUCKETS.indexOf(bucket) * 2 + 1) / 6;
      const seed = candidates.reduce((best, segment) => Math.abs(segment.startMs - target) < Math.abs(best.startMs - target) ? segment : best);
      addNeighborhood(seed.segmentIndex, bucket, true);
    }
    const common = {
      projectionVersion: 2 as const, identity: saved.identity,
      locator: { version: 1 as const, sourceVideoMediaId: saved.identity.sourceVideoMediaId,
        sourceVideoContentHash: saved.identity.sourceVideoContentHash, analyzerFingerprintSha256: saved.identity.analyzerFingerprint.sha256 },
      jobId: saved.jobId, artifact: saved.completed!.artifact,
      library: { id: library.id, version: library.version, durationMs: library.durationMs,
        analysisModels: library.analysisModels, providerEligible: false as const, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const },
    };
    const makeContext = (): VideoPlanningContextV2 => {
      const windows = buildTranscriptWindows(library.transcript.segments, selectedSegments);
      const included = new Set(windows.flatMap(window => window.segments.map(segment => segment.segmentIndex)));
      const observationContext = new Set(windows.filter(window => window.selectionReasons.includes('OBSERVATION_CONTEXT'))
        .flatMap(window => window.segments.map(segment => segment.segmentIndex)));
      const observations: V2Observation[] = [...selectedObservationIndexes].sort((a, b) => a - b).map(representativeOrdinal => {
        const { id, timestampMs, frameSha256, evidenceStatus, observation, transcriptSegments } = library.representativeFrames[representativeOrdinal];
        const bucket = timeBucket(timestampMs, library.durationMs);
        return { representativeOrdinal, id, timestampMs, frameSha256, evidenceStatus, observation,
          transcriptSegments: transcriptSegments.filter(segment => included.has(segment.segmentIndex) && observationContext.has(segment.segmentIndex)), selectionReasons: [bucket] };
      });
      const buckets = BUCKETS.map(bucket => ({ bucket, availableCount: availableByBucket.get(bucket)!.length,
        includedCount: observations.filter(observation => observation.selectionReasons[0] === bucket).length }));
      return { ...common,
        transcript: { status: library.transcript.status === 'SKIPPED_NO_AUDIO_TRACK' ? 'NO_AUDIO_TRACK' : 'AVAILABLE',
          model: library.transcript.model, language: library.transcript.language, totalSegmentCount: library.transcript.segments.length,
          includedSegmentCount: included.size, coverage: included.size === library.transcript.segments.length ? 'COMPLETE' : 'BOUNDED_WINDOWS_V2', windows },
        observationCoverage: { totalRepresentativeCount: library.representativeFrames.length,
          coverage: observations.length === library.representativeFrames.length ? 'COMPLETE' : 'ELAPSED_TIME_BUCKETS_V2', buckets }, observations };
    };
    if (Buffer.byteLength(JSON.stringify(makeContext())) > MAX_PLANNING_VIDEO_CONTEXT_BYTES) return fail();
    for (const index of optionalObservationIndexes) {
      if (selectedObservationIndexes.size >= MAX_PLANNING_VIDEO_OBSERVATIONS) break;
      selectedObservationIndexes.add(index);
      if (Buffer.byteLength(JSON.stringify(makeContext())) > MAX_PLANNING_VIDEO_CONTEXT_BYTES) selectedObservationIndexes.delete(index);
    }
    const optionalSeeds: Array<[number, VideoPlanningSelectionReason]> = [];
    for (const index of selectedObservationIndexes) for (const segment of library.representativeFrames[index].transcriptSegments) {
      if (library.transcript.segments[segment.segmentIndex] && isDeepStrictEqual(library.transcript.segments[segment.segmentIndex], segment)) optionalSeeds.push([segment.segmentIndex, 'OBSERVATION_CONTEXT']);
    }
    for (const index of uniformIndexes(library.transcript.segments.length, MAX_PLANNING_VIDEO_TRANSCRIPT_EXCERPTS)) optionalSeeds.push([index, timeBucket(library.transcript.segments[index].startMs, library.durationMs)]);
    for (const [seed, reason] of optionalSeeds) {
      const before = [...selectedSegments.entries()].map(([index, reasons]) => [index, [...reasons]] as const);
      if (!addNeighborhood(seed, reason, false)) continue;
      if (Buffer.byteLength(JSON.stringify(makeContext())) > MAX_PLANNING_VIDEO_CONTEXT_BYTES) {
        selectedSegments.clear();
        for (const [index, reasons] of before) selectedSegments.set(index, new Set(reasons));
      }
    }
    const intelligence = makeContext();
    parseVideoPlanningContext(intelligence, { mediaId: saved.identity.sourceVideoMediaId, sha256: saved.identity.sourceVideoContentHash });
    return [saved.identity.sourceVideoMediaId, intelligence] as const;
  }));
  return { version: 1, entries: state.entries.map(entry => {
    if (entry.source.role !== 'TRA_VIDEO') return structuredClone(entry);
    const intelligence = replacements.get(entry.source.mediaId);
    if (!intelligence || (entry.analyzer.kind !== 'REPRESENTATIVE_VIDEO_FRAMES' && entry.analyzer.kind !== 'VIDEO_INTELLIGENCE')) return fail();
    return { source: structuredClone(entry.source), analyzer: { kind: 'VIDEO_INTELLIGENCE' as const,
      model: intelligence.identity.analyzerFingerprint.visionModel, schemaVersion: 1 as const, contextSha256: null },
      evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const, result: { kind: 'VIDEO_INTELLIGENCE' as const, intelligence } };
  }) };
}

export function videoDependenciesFromPlanningSourceAnalysis(state: PlanningSourceAnalysisState | undefined) {
  return state?.entries.flatMap(entry => entry.result?.kind === 'VIDEO_INTELLIGENCE'
    ? [{ version: 1 as const, identity: entry.result.intelligence.identity, jobId: entry.result.intelligence.jobId,
      completed: { artifact: entry.result.intelligence.artifact,
        library: { id: entry.result.intelligence.library.id, version: entry.result.intelligence.library.version } } }]
    : []) ?? [];
}
