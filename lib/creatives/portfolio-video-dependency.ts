import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CreativeSourceSelection } from '@/lib/media/types';
import { MAX_CREATIVE_SOURCE_ASSETS } from '@/lib/media/source-limits';
import { videoIntelligenceJobId, type VideoIntelligenceJobIdentity, type VideoIntelligenceArtifactReference } from '@/lib/video/intelligence-job';
import { createVideoIntelligenceAnalyzerFingerprint } from '@/lib/video/intelligence-preparation';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';

/** References only. Readiness never grants evidence, human approval or attachment permission. */
export type PortfolioVideoDependency = {
  version: 1;
  identity: VideoIntelligenceJobIdentity;
  jobId: string;
  completed?: {
    artifact: VideoIntelligenceArtifactReference;
    library: Pick<VideoFrameLibrary, 'id' | 'version'>;
  };
};
export class UnsupportedVideoPreparationVersionError extends Error {
  constructor() { super('Unsupported portfolio video preparation version. A compatible app version is required.'); }
}
const record = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => key in v);
const reject = (): never => { throw new Error('Invalid portfolio video dependency.'); };

/** Pure validation of saved identities; never consult current environment, jobs or providers. */
export function parsePortfolioVideoDependencies(value: unknown, sources: readonly CreativeSourceSelection[]): PortfolioVideoDependency[] {
  if (!Array.isArray(value) || value.length > MAX_CREATIVE_SOURCE_ASSETS) return reject();
  const ids = new Set<string>();
  for (const entry of value) {
    if (!record(entry)) return reject();
    if (entry.version !== 1) throw new UnsupportedVideoPreparationVersionError();
    if (!exact(entry, ['version', 'identity', 'jobId', ...('completed' in entry ? ['completed'] : [])])
      || Buffer.byteLength(JSON.stringify(entry)) > 4096 || !record(entry.identity)
      || !exact(entry.identity, ['sourceVideoMediaId', 'sourceVideoContentHash', 'analyzerFingerprint'])) return reject();
    const identity = entry.identity as VideoIntelligenceJobIdentity;
    if (ids.has(identity.sourceVideoMediaId)
      || !sources.some(source => source.mediaId === identity.sourceVideoMediaId && source.role === 'TRA_VIDEO')) return reject();
    ids.add(identity.sourceVideoMediaId);
    try {
      const fingerprint = identity.analyzerFingerprint;
      if (typeof fingerprint?.visionModel !== 'string' || fingerprint.visionModel.length > 200
        || !isDeepStrictEqual(fingerprint, createVideoIntelligenceAnalyzerFingerprint(fingerprint.candidatePolicy, fingerprint.visionModel))
        || entry.jobId !== videoIntelligenceJobId(identity)) return reject();
    } catch { return reject(); }
    if ('completed' in entry) {
      const done = entry.completed, artifact = done?.artifact, library = done?.library;
      const libraryId = 'video-library:' + createHash('sha256')
        .update(identity.sourceVideoMediaId + ':' + identity.sourceVideoContentHash).digest('hex');
      if (!record(done) || !exact(done, ['artifact', 'library']) || !record(artifact)
        || !exact(artifact, ['key', 'sha256', 'byteLength']) || typeof artifact.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(artifact.sha256) || artifact.key !== `libraries/sha256/${artifact.sha256}.json`
        || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1 || artifact.byteLength > 32 * 1024 * 1024
        || !record(library) || !exact(library, ['id', 'version'])) return reject();
      if (library.version !== 1) throw new UnsupportedVideoPreparationVersionError();
      if (library.id !== libraryId) return reject();
    }
  }
  return structuredClone(value) as PortfolioVideoDependency[];
}

/** Append dependencies/complete a pending reference, but never replace existing identity or completion. */
export function preservesVideoDependencies(current: readonly PortfolioVideoDependency[], next: readonly PortfolioVideoDependency[]) {
  return current.every(saved => {
    const found = next.find(entry => entry.identity.sourceVideoMediaId === saved.identity.sourceVideoMediaId);
    return found && saved.version === found.version && saved.jobId === found.jobId
      && isDeepStrictEqual(saved.identity, found.identity)
      && (saved.completed === undefined || isDeepStrictEqual(saved.completed, found.completed));
  });
}
