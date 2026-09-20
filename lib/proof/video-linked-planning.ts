import type { PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';
import {
  selectProofForPlanning,
  type PlanningProofRecord,
  type PlanningProofReference,
} from '@/lib/proof/planning';
import { getProofLibrarySnapshot } from '@/lib/proof/storage';
import type {
  ProofRecord,
  VideoPassageCandidateView,
} from '@/lib/proof/types';

export const MAX_VIDEO_LINKED_CUSTOMER_INSIGHTS = 8;
export const MAX_VIDEO_LINKED_CUSTOMER_INSIGHT_CHARS = 16_000;

export type VideoLinkedCustomerInsight = {
  candidateId: string;
  evidenceStatus: 'UNVERIFIED_SOURCE_PASSAGE';
  source: {
    mediaId: string;
    sha256: string;
    analyzerFingerprintSha256: string;
    libraryId: string;
    libraryVersion: 1;
  };
  passage: VideoPassageCandidateView['passage'];
  linkedProofReference: PlanningProofReference;
};

const exactCurrentProof = (
  candidate: VideoPassageCandidateView,
  records: readonly ProofRecord[]
) => {
  if (candidate.status !== 'LINKED' || candidate.linkHealth !== 'CURRENT' || !candidate.link) {
    return null;
  }
  return records.find((record) =>
    record.id === candidate.link!.proofId &&
    record.type === candidate.link!.proofType &&
    record.updatedAt === candidate.link!.proofUpdatedAt &&
    record.status === 'ACTIVE' &&
    record.advertisingUseApproved === true
  ) ?? null;
};

const matchesCurrentVideoIntelligence = (
  candidate: VideoPassageCandidateView,
  sourceAnalysis: PlanningSourceAnalysisState
) => sourceAnalysis.entries.some((entry) => {
  if (entry.source.role !== 'TRA_VIDEO' || entry.result?.kind !== 'VIDEO_INTELLIGENCE') return false;
  const intelligence = entry.result.intelligence;
  return entry.source.mediaId === candidate.source.locator.sourceVideoMediaId &&
    entry.source.sha256 === candidate.source.locator.sourceVideoContentHash &&
    intelligence.locator.version === candidate.source.locator.version &&
    intelligence.locator.sourceVideoMediaId === candidate.source.locator.sourceVideoMediaId &&
    intelligence.locator.sourceVideoContentHash === candidate.source.locator.sourceVideoContentHash &&
    intelligence.locator.analyzerFingerprintSha256 === candidate.source.locator.analyzerFingerprintSha256 &&
    intelligence.library.id === candidate.source.library.id &&
    intelligence.library.version === candidate.source.library.version;
});

export function projectVideoLinkedCustomerInsights(
  sourceAnalysis: PlanningSourceAnalysisState,
  records: readonly ProofRecord[],
  candidates: readonly VideoPassageCandidateView[]
): VideoLinkedCustomerInsight[] {
  const selected: VideoLinkedCustomerInsight[] = [];
  let serializedChars = 0;
  const ordered = [...candidates].sort((a, b) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
  for (const candidate of ordered) {
    if (selected.length >= MAX_VIDEO_LINKED_CUSTOMER_INSIGHTS ||
      !matchesCurrentVideoIntelligence(candidate, sourceAnalysis)) continue;
    const proof = exactCurrentProof(candidate, records);
    if (!proof) continue;
    const insight: VideoLinkedCustomerInsight = {
      candidateId: candidate.id,
      evidenceStatus: 'UNVERIFIED_SOURCE_PASSAGE',
      source: {
        mediaId: candidate.source.locator.sourceVideoMediaId,
        sha256: candidate.source.locator.sourceVideoContentHash,
        analyzerFingerprintSha256: candidate.source.locator.analyzerFingerprintSha256,
        libraryId: candidate.source.library.id,
        libraryVersion: candidate.source.library.version,
      },
      passage: structuredClone(candidate.passage),
      linkedProofReference: {
        id: proof.id,
        type: proof.type,
        updatedAt: proof.updatedAt,
      },
    };
    const chars = JSON.stringify(insight).length;
    if (serializedChars + chars > MAX_VIDEO_LINKED_CUSTOMER_INSIGHT_CHARS) continue;
    selected.push(insight);
    serializedChars += chars;
  }
  return selected;
}

export async function loadVideoLinkedPlanningInputs(
  sourceAnalysis: PlanningSourceAnalysisState,
  proofRetrievalQuery: string
): Promise<{
  customerInsights: VideoLinkedCustomerInsight[];
  proofCatalog: PlanningProofRecord[];
}> {
  const snapshot = await getProofLibrarySnapshot();
  const projected = projectVideoLinkedCustomerInsights(
    sourceAnalysis,
    snapshot.items,
    snapshot.candidates
  );
  const proofCatalog = selectProofForPlanning(
    snapshot.items,
    proofRetrievalQuery,
    projected.map((insight) => insight.linkedProofReference)
  );
  const available = new Set(proofCatalog.map((proof) =>
    `${proof.id}:${proof.type}:${proof.updatedAt}`));
  return {
    customerInsights: projected.filter((insight) => available.has(
      `${insight.linkedProofReference.id}:${insight.linkedProofReference.type}:${insight.linkedProofReference.updatedAt}`
    )),
    proofCatalog,
  };
}
