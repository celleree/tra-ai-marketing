import { describe, expect, it } from 'vitest';
import type { PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';
import {
  MAX_VIDEO_LINKED_CUSTOMER_INSIGHTS,
  projectVideoLinkedCustomerInsights,
} from '@/lib/proof/video-linked-planning';
import type { ProofRecord, VideoPassageCandidateView } from '@/lib/proof/types';

const mediaId = `media_${'a'.repeat(32)}`;
const sourceHash = 'b'.repeat(64);
const analyzerHash = 'c'.repeat(64);
const libraryId = `video-library:${'d'.repeat(64)}`;
const proof = (hex = 'e'): ProofRecord => ({
  id: `proof_${hex.repeat(32)}`,
  type: 'case-study',
  title: 'Customer outcome',
  verifiedFacts: [],
  approvedClaimWording: 'Approved exact claim.',
  sourceNote: 'Internal source.',
  tags: ['outcome'],
  status: 'ACTIVE',
  advertisingUseApproved: true,
  createdAt: '2026-09-19T10:00:00.000Z',
  updatedAt: '2026-09-19T10:00:00.000Z',
});
const sourceAnalysis = (): PlanningSourceAnalysisState => ({
  version: 1,
  entries: [{
    source: { role: 'TRA_VIDEO', mediaId, sha256: sourceHash },
    analyzer: { kind: 'VIDEO_INTELLIGENCE', model: 'vision', schemaVersion: 1, contextSha256: null },
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION',
    result: { kind: 'VIDEO_INTELLIGENCE', intelligence: {
      locator: { version: 1, sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash,
        analyzerFingerprintSha256: analyzerHash },
      library: { id: libraryId, version: 1 },
    } as never },
  }],
});
const candidate = (
  record: ProofRecord,
  index = 0,
  overrides: Partial<VideoPassageCandidateView> = {}
): VideoPassageCandidateView => ({
  version: 1,
  id: `video-passage_${String(index).padStart(64, '0')}`,
  status: 'LINKED',
  source: {
    locator: { version: 1, sourceVideoMediaId: mediaId, sourceVideoContentHash: sourceHash,
      analyzerFingerprintSha256: analyzerHash },
    library: { id: libraryId, version: 1 },
  },
  passage: {
    startSegmentIndex: index,
    endSegmentIndex: index,
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    segments: [{ segmentIndex: index, startMs: index * 1000, endMs: index * 1000 + 900,
      text: `Exact source passage ${index}.` }],
  },
  link: { proofId: record.id, proofType: record.type, proofUpdatedAt: record.updatedAt },
  linkHealth: 'CURRENT',
  createdAt: `2026-09-19T10:00:${String(index).padStart(2, '0')}.000Z`,
  updatedAt: `2026-09-19T10:00:${String(index).padStart(2, '0')}.000Z`,
  ...overrides,
});

describe('video-linked planner projection', () => {
  it('projects only exact-current linked passages and keeps them explicitly non-Proof', () => {
    const current = proof();
    const projected = projectVideoLinkedCustomerInsights(sourceAnalysis(), [current], [
      candidate(current, 0),
      candidate(current, 1, { status: 'PENDING', link: undefined, linkHealth: 'UNLINKED' }),
      candidate(current, 2, { linkHealth: 'CHANGED' }),
      candidate(current, 3, { source: { locator: { ...candidate(current).source.locator,
        analyzerFingerprintSha256: 'f'.repeat(64) }, library: { id: libraryId, version: 1 } } }),
    ]);

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      candidateId: candidate(current).id,
      evidenceStatus: 'UNVERIFIED_SOURCE_PASSAGE',
      linkedProofReference: { id: current.id, type: current.type, updatedAt: current.updatedAt },
      passage: candidate(current).passage,
    });
    expect(projected[0]).not.toHaveProperty('approvedClaimWording');
  });

  it('rechecks ACTIVE and advertising-use approval and preserves the passage count bound', () => {
    const records = Array.from({ length: MAX_VIDEO_LINKED_CUSTOMER_INSIGHTS + 2 }, (_, index) =>
      proof(index.toString(16)));
    const candidates = records.map((record, index) => candidate(record, index));
    expect(projectVideoLinkedCustomerInsights(sourceAnalysis(), records, candidates))
      .toHaveLength(MAX_VIDEO_LINKED_CUSTOMER_INSIGHTS);
    expect(projectVideoLinkedCustomerInsights(sourceAnalysis(), [
      { ...records[0], status: 'INACTIVE' },
      { ...records[1], advertisingUseApproved: false },
    ], candidates.slice(0, 2))).toEqual([]);
  });
});
