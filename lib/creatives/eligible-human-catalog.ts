import type { CreativeGenerationProvenance } from '@/lib/creatives/generation-provenance';
import type { ApprovedHumanFrame } from '@/lib/video/approved-human';
import { listApprovedHumanFrames } from '@/lib/video/approved-human-store';
import type { GeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';

export const ELIGIBLE_HUMAN_CATALOG_VERSION = 1 as const;

type RequestedSource = CreativeGenerationProvenance['requestedSources'][number];

type EligibleHumanIdentity = {
  identityVersion: 1;
  sourceId: string;
  sourceMediaId: string;
  sourceContentSha256: string;
  pixelSha256: string;
};

export type EligibleHumanCandidate =
  | (EligibleHumanIdentity & {
      kind: 'APPROVED_HUMAN_RECORD';
      recordId: string;
      recordVersion: 1;
      sourceName: string;
      description: string;
      libraryId: string;
      libraryFrameId: string;
      timestampMs: number;
      candidateFrameSha256: string;
      approvalState: 'ACTIVE';
      approvedAt: string;
      updatedAt: string;
    })
  | (EligibleHumanIdentity & {
      kind: 'SELECTED_VIDEO_FRAME';
      selectionVersion: 1;
      libraryId: string;
      libraryFrameId: string;
      timestampMs: number;
      candidateFrameSha256: string;
      approvalState: 'APPROVED_SELECTION';
    })
  | (EligibleHumanIdentity & {
      kind: 'APPROVED_VIDEO_FRAME';
      frameVersion: 1;
      frameIndex: number;
      timestampMs: number;
      approvalState: 'APPROVED_FRAME';
    })
  | (EligibleHumanIdentity & {
      kind: 'TRA_REFERENCE_IMAGE';
      sourceRole: 'TRA_REFERENCE';
      approvalState: 'ROLE_ELIGIBLE';
      approvalVersion: 1;
    });

export type EligibleHumanCatalogV1 = {
  version: typeof ELIGIBLE_HUMAN_CATALOG_VERSION;
  candidates: EligibleHumanCandidate[];
};

export type EligibleHumanCatalogInput = {
  approvedHumans: readonly ApprovedHumanFrame[];
  selectedVideoFrames?: readonly GeneratedVideoFrameSelection[];
  approvedVideoFrames?: readonly ApprovedTraVideoFrame[];
  requestedSources?: readonly RequestedSource[];
};

const candidatePriority: Record<EligibleHumanCandidate['kind'], number> = {
  APPROVED_HUMAN_RECORD: 0,
  SELECTED_VIDEO_FRAME: 1,
  APPROVED_VIDEO_FRAME: 2,
  TRA_REFERENCE_IMAGE: 3,
};

const identityKey = (candidate: EligibleHumanCandidate) =>
  `${candidate.sourceMediaId}:${candidate.sourceContentSha256}:${candidate.pixelSha256}`;

/** Exact duplicate pixels are one candidate; conflicting stable source IDs fail closed. */
function dedupeCandidates(candidates: EligibleHumanCandidate[]) {
  const bySourceId = new Map<string, EligibleHumanCandidate>();
  const conflictingIds = new Set<string>();
  for (const candidate of candidates) {
    const existing = bySourceId.get(candidate.sourceId);
    if (!existing) bySourceId.set(candidate.sourceId, candidate);
    else if (identityKey(existing) !== identityKey(candidate)) conflictingIds.add(candidate.sourceId);
  }
  for (const sourceId of conflictingIds) bySourceId.delete(sourceId);

  const seenPixels = new Set<string>();
  return [...bySourceId.values()]
    .sort((a, b) => candidatePriority[a.kind] - candidatePriority[b.kind] || a.sourceId.localeCompare(b.sourceId))
    .filter((candidate) => {
      if (seenPixels.has(candidate.pixelSha256)) return false;
      seenPixels.add(candidate.pixelSha256);
      return true;
    })
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

export function buildEligibleHumanCatalog(input: EligibleHumanCatalogInput): EligibleHumanCatalogV1 {
  const candidates: EligibleHumanCandidate[] = [];

  for (const record of input.approvedHumans) {
    if (!record.active) continue;
    const frame = record.source.frames[0];
    candidates.push({
      identityVersion: 1,
      sourceId: `approved-human:${record.id}`,
      kind: 'APPROVED_HUMAN_RECORD',
      sourceMediaId: record.source.sourceVideoMediaId,
      sourceContentSha256: record.source.sourceVideoContentHash,
      pixelSha256: frame.approvedPngSha256,
      recordId: record.id,
      recordVersion: record.version,
      sourceName: record.sourceName,
      description: record.description,
      libraryId: record.source.libraryId,
      libraryFrameId: frame.libraryFrameId,
      timestampMs: frame.timestampMs,
      candidateFrameSha256: frame.candidateFrameSha256,
      approvalState: 'ACTIVE',
      approvedAt: record.approvedAt,
      updatedAt: record.updatedAt,
    });
  }

  for (const selection of input.selectedVideoFrames ?? []) {
    for (const frame of selection.frames) {
      candidates.push({
        identityVersion: 1,
        sourceId: `video-frame:${selection.sourceVideoMediaId}:${frame.libraryFrameId}`,
        kind: 'SELECTED_VIDEO_FRAME',
        sourceMediaId: selection.sourceVideoMediaId,
        sourceContentSha256: selection.sourceVideoContentHash,
        pixelSha256: frame.approvedPngSha256,
        selectionVersion: 1,
        libraryId: selection.libraryId,
        libraryFrameId: frame.libraryFrameId,
        timestampMs: frame.timestampMs,
        candidateFrameSha256: frame.candidateFrameSha256,
        approvalState: 'APPROVED_SELECTION',
      });
    }
  }

  for (const frame of input.approvedVideoFrames ?? []) {
    if (!frame.approvedHumanSource) continue;
    candidates.push({
      identityVersion: 1,
      sourceId: `approved-video-frame:${frame.sourceVideoMediaId}:${frame.frameSha256}`,
      kind: 'APPROVED_VIDEO_FRAME',
      sourceMediaId: frame.sourceVideoMediaId,
      sourceContentSha256: frame.sourceVideoContentHash,
      pixelSha256: frame.frameSha256,
      frameVersion: 1,
      frameIndex: frame.frameIndex,
      timestampMs: frame.timestampMs,
      approvalState: 'APPROVED_FRAME',
    });
  }

  for (const source of input.requestedSources ?? []) {
    if (source.role !== 'TRA_REFERENCE') continue;
    candidates.push({
      identityVersion: 1,
      sourceId: `tra-reference:${source.mediaId}`,
      kind: 'TRA_REFERENCE_IMAGE',
      sourceMediaId: source.mediaId,
      sourceContentSha256: source.sha256,
      pixelSha256: source.sha256,
      sourceRole: 'TRA_REFERENCE',
      approvalState: 'ROLE_ELIGIBLE',
      approvalVersion: 1,
    });
  }

  return { version: ELIGIBLE_HUMAN_CATALOG_VERSION, candidates: dedupeCandidates(candidates) };
}

/** Complete approved-human inventory: unlike the legacy planner option list, this never applies a MAX 8 slice. */
export async function loadEligibleHumanCatalog(
  input: Omit<EligibleHumanCatalogInput, 'approvedHumans'>,
): Promise<EligibleHumanCatalogV1> {
  return buildEligibleHumanCatalog({ ...input, approvedHumans: await listApprovedHumanFrames() });
}
