import type { CreativeReferenceAnalysis } from '@/lib/ai/openai';
import type { CreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import type { ProofRecord } from '@/lib/proof/types';
import type { ReferencePlanningCandidate } from '@/lib/references/planning';
import type { ApprovedHumanFrame } from '@/lib/video/approved-human';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import type { GeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import type { VideoIntelligenceJob } from '@/lib/video/intelligence-job';
import type { VideoIntelligenceJobIdentity } from '@/lib/video/intelligence-job';
import type { VideoIntelligenceJobLocator } from '@/lib/video/intelligence-service';
import type { ResolvedLayoutBlueprint } from '@/lib/layouts/service';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';
import type { VideoTranscriptSegment } from '@/lib/video/transcript';

type SourceIdentity = CreativeGenerationProvenance['requestedSources'][number];
type SourceOfRole<Role extends SourceIdentity['role']> = Omit<SourceIdentity, 'role'> & { role: Role };

/** A2 preparation projection; representative stills do not constitute full Video Intelligence. */
export type PlanningSourceAnalysisResult =
  | { kind: 'LAYOUT_BLUEPRINT'; layout: ResolvedLayoutBlueprint }
  | { kind: 'LAYOUT_ANGLE'; angleDescription: string }
  | { kind: 'TRA_REFERENCE'; analysis: CreativeReferenceAnalysis }
  | { kind: 'VIDEO_INTELLIGENCE'; intelligence: VideoPlanningContext }
  | { kind: 'REPRESENTATIVE_VIDEO_FRAMES'; analysis: CreativeReferenceAnalysis;
      analyzedFrames: Array<Pick<ApprovedTraVideoFrame, 'timestampMs' | 'frameSha256'>> };

export type PlanningSourceAnalysisState = {
  version: 1;
  // Serializes identities and results only; owning jobs must handle leases and uncertain paid work.
  entries: Array<{
    source: SourceIdentity;
    analyzer: { kind: PlanningSourceAnalysisResult['kind']; model: string; schemaVersion: 1; contextSha256: string | null };
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION';
    result?: PlanningSourceAnalysisResult;
  }>;
};

/** Data availability only. READY never grants evidence, identity or provider permission. */
export type PlanningSourceReadiness<T> =
  | { status: 'PENDING' }
  | { status: 'READY'; value: T }
  | { status: 'UNAVAILABLE' | 'RETRY_REQUIRED'; reason: string };

/** NOT_REQUESTED differs from a successfully retrieved empty catalog. */
type PlanningCatalog<T> = { status: 'NOT_REQUESTED' } | PlanningSourceReadiness<T[]>;

type VideoPlanningContextBase = {
  identity: VideoIntelligenceJobIdentity;
  locator: VideoIntelligenceJobLocator;
  jobId: VideoIntelligenceJob['id'];
  artifact: NonNullable<VideoIntelligenceJob['result']>;
  library: Pick<VideoFrameLibrary,
    'id' | 'version' | 'durationMs' | 'analysisModels' | 'providerEligible' | 'evidenceStatus'>;
};

type VideoPlanningObservation = Pick<VideoFrameLibrary['representativeFrames'][number],
  'id' | 'timestampMs' | 'frameSha256' | 'evidenceStatus' | 'observation' | 'transcriptSegments'> & {
    representativeOrdinal: number;
  };

/** Frozen B1.3 projection. Its absent projectionVersion dispatches as v1. */
export type VideoPlanningContextV1 = VideoPlanningContextBase & {
  // B retrieves bounded excerpts, retaining timestamps and frame identity; never thumbnails.
  transcript: {
    status: 'AVAILABLE' | 'NO_AUDIO_TRACK';
    model: VideoFrameLibrary['transcript']['model'];
    language: VideoFrameLibrary['transcript']['language'];
    totalSegmentCount: number;
    coverage: 'COMPLETE' | 'UNIFORM_TIMELINE_V1';
    excerpts: VideoFrameLibrary['transcript']['segments'];
  };
  observationCoverage: {
    totalRepresentativeCount: number;
    coverage: 'COMPLETE' | 'UNIFORM_TIMELINE_V1';
  };
  observations: VideoPlanningObservation[];
};

export type VideoPlanningTimeBucket = 'EARLY' | 'MIDDLE' | 'LATE';
export type VideoPlanningSelectionReason = VideoPlanningTimeBucket | 'OBSERVATION_CONTEXT';

export type VideoPlanningContextV2 = VideoPlanningContextBase & {
  projectionVersion: 2;
  transcript: {
    status: 'AVAILABLE' | 'NO_AUDIO_TRACK';
    model: VideoFrameLibrary['transcript']['model'];
    language: VideoFrameLibrary['transcript']['language'];
    totalSegmentCount: number;
    includedSegmentCount: number;
    coverage: 'COMPLETE' | 'BOUNDED_WINDOWS_V2';
    windows: Array<{
      firstSegmentIndex: number;
      lastSegmentIndex: number;
      startMs: number;
      endMs: number;
      selectionReasons: VideoPlanningSelectionReason[];
      segments: VideoTranscriptSegment[];
    }>;
  };
  observationCoverage: {
    totalRepresentativeCount: number;
    coverage: 'COMPLETE' | 'ELAPSED_TIME_BUCKETS_V2';
    buckets: Array<{
      bucket: VideoPlanningTimeBucket;
      availableCount: number;
      includedCount: number;
    }>;
  };
  observations: Array<VideoPlanningObservation & { selectionReasons: [VideoPlanningTimeBucket] }>;
};

export type VideoPlanningContext = VideoPlanningContextV1 | VideoPlanningContextV2;

type TraReferencePlanningAnalysis = {
  analysis: CreativeReferenceAnalysis;
  // Capture at analysis time. Null means unknown historical metadata, not a cache hit.
  analyzer: { model: string; schemaVersion: number; contextSha256: string } | null;
  evidenceStatus: 'CREATIVE_INSPIRATION_ONLY';
};

/** Candidate identities only; C revalidates approval/source binding before selecting or rendering. */
type HumanPlanningCandidate =
  | { kind: 'APPROVED_HUMAN_RECORD'; record: Pick<ApprovedHumanFrame,
      'id' | 'version' | 'updatedAt' | 'sourceName' | 'description' | 'source' | 'extractionVersion'
      | 'approvedBy' | 'approvedAt' | 'active'> }
  | { kind: 'SELECTED_VIDEO_FRAMES'; source: GeneratedVideoFrameSelection }
  | { kind: 'TRA_REFERENCE_IMAGE'; source: SourceOfRole<'TRA_REFERENCE'> };

/** D resolves exact wording and permissions from this revision; ACTIVE alone is not use approval. */
type PlanningProofReference = Pick<ProofRecord, 'id' | 'type' | 'updatedAt'>;

/**
 * A1 contract only: no runtime producer, parser, persistence migration or provider consumer.
 * JSON data/projections over existing stores, not a new source/approval database.
 * Existing job state owns scheduling/retry; readiness describes an inventory snapshot.
 * Future consumers validate IDs, hashes, versions and roles using the owning domains.
 */
export type PlanningSourcePacketV1 = {
  version: 1;
  requestedSources: CreativeGenerationProvenance['requestedSources'];
  // Empty source arrays mean no source of that role was supplied, never failed preparation.
  videoIntelligence: Array<{
    source: SourceOfRole<'TRA_VIDEO'>;
    readiness: PlanningSourceReadiness<VideoPlanningContext>;
  }>;
  traReferenceAnalyses: Array<{
    source: SourceOfRole<'TRA_REFERENCE'>;
    readiness: PlanningSourceReadiness<TraReferencePlanningAnalysis>;
  }>;
  // Blueprint carries its schema version; angle descriptions are inspiration, not proof.
  referenceCatalog: PlanningCatalog<ReferencePlanningCandidate>;
  humanCandidates: PlanningCatalog<HumanPlanningCandidate>;
  proofReferences: PlanningCatalog<PlanningProofReference>;
};
