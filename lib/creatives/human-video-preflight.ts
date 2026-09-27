import { createHash } from 'node:crypto';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import { parseApprovedHumanSourceId } from '@/lib/video/approved-human';
import { resolveApprovedHumanFrame } from '@/lib/video/approved-human-service';
import { prepareProviderVideoFrames } from '@/lib/video/source-overlay';
import type { ApprovedTraVideoFrameSet } from '@/lib/video/types';

type ApprovedHuman = Awaited<ReturnType<typeof resolveApprovedHumanFrame>>;
export type PlannedHumanVideoSource = { human: ApprovedHuman | null; videoFrames: ApprovedTraVideoFrameSet | null };

/** Mirror the final attachment choice without planning or image generation. */
export async function resolvePlannedHumanVideoSource(
  concept: Pick<PlannedCreativeConcept, 'strategy'>,
  sources: { videoFrameSet: ApprovedTraVideoFrameSet | null; providerImageSource?: unknown },
): Promise<PlannedHumanVideoSource> {
  if (concept.strategy.execution.subjectSource !== 'approved-tra-human') return { human: null, videoFrames: null };
  const humanRecordId = concept.strategy.humanSourceId
    ? parseApprovedHumanSourceId(concept.strategy.humanSourceId)
    : concept.strategy.approvedHumanId ?? null;
  if (concept.strategy.humanSourceId && !humanRecordId) throw new Error('Unsupported or invalid human source ID.');
  const human = humanRecordId ? await resolveApprovedHumanFrame(humanRecordId) : null;
  const videoFrames = human?.selected ?? (sources.providerImageSource ? null : sources.videoFrameSet);
  return { human, videoFrames };
}

export async function preflightApprovedTraVideoFrameSet(set: ApprovedTraVideoFrameSet): Promise<void> {
  const { source, sourceVideoContentHash, frames } = set;
  const actualSourceHash = createHash('sha256').update(source.stored.buffer).digest('hex');
  if (source.role !== 'TRA_VIDEO' || sourceVideoContentHash !== actualSourceHash || frames.some(frame =>
    frame.sourceRole !== 'TRA_VIDEO' || frame.approvedHumanSource !== true
    || frame.sourceVideoMediaId !== source.media.id || frame.sourceVideoContentHash !== actualSourceHash
    || frame.sourceVideoFileName !== source.media.fileName)) {
    throw new Error('Approved TRA video frame provenance no longer matches its source video. Select an approved frame again.');
  }
  await prepareProviderVideoFrames(frames);
}

export async function preflightPlannedHumanVideoSource(
  concept: Pick<PlannedCreativeConcept, 'strategy'>,
  sources: { videoFrameSet: ApprovedTraVideoFrameSet | null; providerImageSource?: unknown },
): Promise<PlannedHumanVideoSource> {
  const resolved = await resolvePlannedHumanVideoSource(concept, sources);
  if (resolved.videoFrames) await preflightApprovedTraVideoFrameSet(resolved.videoFrames);
  return resolved;
}
