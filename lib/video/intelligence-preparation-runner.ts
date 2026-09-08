import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import type { VideoIntelligenceJob, VideoIntelligenceJobIdentity } from '@/lib/video/intelligence-job';
import {
  checkpointVideoIntelligenceJob,
  readVideoIntelligenceJob,
  VideoIntelligenceJobLeaseLostError,
} from '@/lib/video/intelligence-job-store';
import {
  prepareAndPersistVideoIntelligencePreparation,
} from '@/lib/video/intelligence-preparation-persistence';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

export interface VideoIntelligencePreparationRunnerDependencies {
  storage?: VideoIntelligenceStorage;
  now?: () => number;
  prepare?: typeof prepareAndPersistVideoIntelligencePreparation;
}

const sourceHash = (source: HydratedTraVideoSource) =>
  createHash('sha256').update(source.stored.buffer).digest('hex');

const validateSource = (
  source: HydratedTraVideoSource,
  job: VideoIntelligenceJob,
  identity: VideoIntelligenceJobIdentity
) => {
  const contentHash = sourceHash(source);
  if (
    source.role !== 'TRA_VIDEO'
    || source.media.id !== job.sourceVideoMediaId
    || source.media.id !== identity.sourceVideoMediaId
    || source.media.mediaType !== 'VIDEO'
    || source.media.mimeType !== 'video/mp4'
    || source.stored.mediaType !== 'VIDEO'
    || source.stored.mimeType !== 'video/mp4'
    || contentHash !== job.sourceVideoContentHash
    || contentHash !== identity.sourceVideoContentHash
  ) {
    throw new Error('Video intelligence preparation requires the matching hydrated TRA_VIDEO MP4.');
  }
};

export const runVideoIntelligencePreparationJob = async (
  identity: VideoIntelligenceJobIdentity,
  leaseId: string,
  source: HydratedTraVideoSource,
  dependencies: VideoIntelligencePreparationRunnerDependencies = {}
): Promise<VideoIntelligenceJob> => {
  const storeDependencies = { storage: dependencies.storage, now: dependencies.now };
  const current = await readVideoIntelligenceJob(identity, storeDependencies);
  if (
    !current
    || current.job.phase !== 'PREPARING'
    || current.job.lease?.id !== leaseId
  ) {
    throw new VideoIntelligenceJobLeaseLostError();
  }

  validateSource(source, current.job, identity);
  const prepare = dependencies.prepare ?? prepareAndPersistVideoIntelligencePreparation;
  const persisted = await prepare(
    source,
    {
      visionModel: current.job.analyzerFingerprint.visionModel,
      policy: { ...current.job.analyzerFingerprint.candidatePolicy },
    },
    { storage: dependencies.storage }
  );
  const manifest = persisted.manifest;
  if (
    manifest.sourceVideoMediaId !== current.job.sourceVideoMediaId
    || manifest.sourceVideoContentHash !== current.job.sourceVideoContentHash
    || !isDeepStrictEqual(manifest.analyzerFingerprint, current.job.analyzerFingerprint)
  ) {
    throw new Error('Video intelligence preparation result does not match the current job.');
  }

  return checkpointVideoIntelligenceJob(
    identity,
    leaseId,
    (job) => ({
      ...job,
      phase: 'TRANSCRIBING',
      preparation: {
        manifestKey: persisted.manifestKey,
        manifestSha256: persisted.manifestSha256,
        durationMs: manifest.durationMs,
        representativeCandidateIndexes: manifest.representativeBundle.entries.map(
          ({ candidateIndex }) => candidateIndex
        ),
      },
      lease: null,
    }),
    storeDependencies
  );
};
