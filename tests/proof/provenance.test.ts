import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaseStudyProofRecord, ReviewProofRecord } from '@/lib/proof/types';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/lib/proof/storage', () => ({ listProofRecords: mocks.list }));

import {
  parseCreativeProofProvenance,
  proofProvenanceFromSelectedProof,
  revalidateCreativeProofProvenanceForPaidWork,
  revalidateSelectedProofForPaidWork,
  validateCreativeProofCopyConsistency,
} from '@/lib/proof/provenance';

const proofId = (hex: string) => `proof_${hex.repeat(32)}`;
const createdAt = '2026-09-18T12:00:00.000Z';
const updatedAt = '2026-09-18T13:00:00.000Z';

const review = (): ReviewProofRecord => ({
  id: proofId('a'),
  type: 'review',
  tags: ['clarity'],
  status: 'ACTIVE',
  advertisingUseApproved: true,
  createdAt,
  updatedAt,
  originalReviewText: 'The representative was patient and explained every step clearly.',
  attribution: { display: 'Verified TRA client', allowed: true },
});

const caseStudy = (): CaseStudyProofRecord => ({
  id: proofId('b'),
  type: 'case-study',
  tags: ['case-study'],
  status: 'ACTIVE',
  advertisingUseApproved: true,
  createdAt,
  updatedAt,
  title: 'Approved case study',
  verifiedFacts: ['Internal fact not available to the planner.'],
  approvedClaimWording: 'TRA helped this client understand the available resolution path.',
  sourceNote: 'Internal approved source.',
  usageRestrictions: 'Use only in general tax-resolution creative.',
  requiredDisclaimer: 'Results vary by individual circumstances.',
});

beforeEach(() => {
  mocks.list.mockReset();
});

describe('creative Proof provenance', () => {
  it('snapshots and revalidates an exact Review selection', async () => {
    const selected = {
      type: 'review' as const,
      proofId: review().id,
      proofUpdatedAt: updatedAt,
      selectedText: 'patient and explained every step clearly.',
      attribution: 'Verified TRA client',
    };
    mocks.list.mockResolvedValue([review()]);

    const snapshot = await revalidateSelectedProofForPaidWork(selected);

    expect(snapshot).toEqual({ version: 1, ...selected });
    await expect(
      revalidateCreativeProofProvenanceForPaidWork(snapshot!)
    ).resolves.toEqual(snapshot);
  });

  it('preserves and revalidates Case Study restrictions and disclaimer', async () => {
    const current = caseStudy();
    const selected = {
      type: 'case-study' as const,
      proofId: current.id,
      proofUpdatedAt: updatedAt,
      selectedText: current.approvedClaimWording,
      usageRestrictions: current.usageRestrictions!,
      requiredDisclaimer: current.requiredDisclaimer!,
    };
    mocks.list.mockResolvedValue([current]);

    await expect(revalidateSelectedProofForPaidWork(selected)).resolves.toEqual({
      version: 1,
      ...selected,
    });
  });

  it.each([
    ['edited/stale', () => ({ ...review(), updatedAt: '2026-09-18T14:00:00.000Z' })],
    ['advertising approval revoked', () => ({ ...review(), advertisingUseApproved: false })],
    ['inactive', () => ({ ...review(), status: 'INACTIVE' as const })],
  ])('fails closed when Review Proof is %s', async (_label, current) => {
    const snapshot = proofProvenanceFromSelectedProof({
      type: 'review',
      proofId: review().id,
      proofUpdatedAt: updatedAt,
      selectedText: 'patient and explained every step clearly.',
      attribution: 'Verified TRA client',
    });
    mocks.list.mockResolvedValue([current()]);

    await expect(
      revalidateCreativeProofProvenanceForPaidWork(snapshot)
    ).rejects.toThrow('Selected Proof must be reselected');
  });

  it('fails closed when Proof was deleted', async () => {
    mocks.list.mockResolvedValue([]);
    const snapshot = proofProvenanceFromSelectedProof({
      type: 'review',
      proofId: review().id,
      proofUpdatedAt: updatedAt,
      selectedText: 'patient and explained every step clearly.',
    });

    await expect(
      revalidateCreativeProofProvenanceForPaidWork(snapshot)
    ).rejects.toThrow('no longer exists');
  });

  it('does not reuse Review attribution when current permission is absent', async () => {
    const current = review();
    delete current.attribution;
    mocks.list.mockResolvedValue([current]);
    const snapshot = proofProvenanceFromSelectedProof({
      type: 'review',
      proofId: review().id,
      proofUpdatedAt: updatedAt,
      selectedText: 'patient and explained every step clearly.',
      attribution: 'Verified TRA client',
    });

    await expect(
      revalidateCreativeProofProvenanceForPaidWork(snapshot)
    ).rejects.toThrow('attribution is no longer permitted');
  });

  it('fails when current Case Study restrictions or disclaimer no longer match', async () => {
    const snapshot = proofProvenanceFromSelectedProof({
      type: 'case-study',
      proofId: caseStudy().id,
      proofUpdatedAt: updatedAt,
      selectedText: caseStudy().approvedClaimWording,
      usageRestrictions: caseStudy().usageRestrictions!,
      requiredDisclaimer: caseStudy().requiredDisclaimer!,
    });
    mocks.list.mockResolvedValue([
      { ...caseStudy(), usageRestrictions: 'Current use is restricted further.' },
    ]);
    await expect(
      revalidateCreativeProofProvenanceForPaidWork(snapshot)
    ).rejects.toThrow('usage restrictions changed');

    mocks.list.mockResolvedValue([
      { ...caseStudy(), requiredDisclaimer: 'Updated disclaimer.' },
    ]);
    await expect(
      revalidateCreativeProofProvenanceForPaidWork(snapshot)
    ).rejects.toThrow('required disclaimer changed');
  });

  it('keeps a historical snapshot readable even after current Proof is revoked', async () => {
    const raw = {
      version: 1,
      type: 'review',
      proofId: review().id,
      proofUpdatedAt: updatedAt,
      selectedText: 'patient and explained every step clearly.',
      attribution: 'Verified TRA client',
    };
    const historical = parseCreativeProofProvenance(raw);
    expect(historical).toEqual(raw);

    mocks.list.mockResolvedValue([{ ...review(), advertisingUseApproved: false }]);
    await expect(
      revalidateCreativeProofProvenanceForPaidWork(historical!)
    ).rejects.toThrow('advertising use is no longer approved');
    expect(historical).toEqual(raw);
  });

  it('requires revised Review copy to retain exact text and attribution', () => {
    const snapshot = proofProvenanceFromSelectedProof({
      type: 'review', proofId: review().id, proofUpdatedAt: updatedAt,
      selectedText: 'patient and explained every step clearly.', attribution: 'Verified TRA client',
    });
    const valid = {
      copy: { primaryText: 'The representative was patient and explained every step clearly.', headline: 'Clarity', description: '' },
      adCopy: { primaryText: 'The representative was patient and explained every step clearly.', headline: 'Clarity', description: '' },
      imageCopy: { headline: 'Clarity', proofAttribution: 'Verified TRA client' },
    };
    expect(() => validateCreativeProofCopyConsistency(snapshot, valid)).not.toThrow();
    expect(() => validateCreativeProofCopyConsistency(snapshot, {
      ...valid, imageCopy: { headline: 'Clarity' },
    })).toThrow('changed or removed the approved Review attribution');
    expect(() => validateCreativeProofCopyConsistency(snapshot, {
      ...valid,
      copy: { ...valid.copy, primaryText: 'Rewritten testimonial.' },
      adCopy: { ...valid.adCopy, primaryText: 'Rewritten testimonial.' },
    })).toThrow('no longer contains the exact selected Proof text');
  });

  it('requires revised Case Study copy to retain exact claim and disclaimer', () => {
    const current = caseStudy();
    const snapshot = proofProvenanceFromSelectedProof({
      type: 'case-study', proofId: current.id, proofUpdatedAt: updatedAt,
      selectedText: current.approvedClaimWording,
      usageRestrictions: current.usageRestrictions!,
      requiredDisclaimer: current.requiredDisclaimer!,
    });
    const valid = {
      copy: { primaryText: current.approvedClaimWording, headline: 'Understand the path', description: '' },
      adCopy: { primaryText: current.approvedClaimWording, headline: 'Understand the path', description: '' },
      imageCopy: { headline: 'Understand the path', disclosure: current.requiredDisclaimer! },
    };
    expect(() => validateCreativeProofCopyConsistency(snapshot, valid)).not.toThrow();
    expect(() => validateCreativeProofCopyConsistency(snapshot, {
      ...valid, imageCopy: { headline: 'Understand the path' },
    })).toThrow('changed or removed the required Case Study disclaimer');
    expect(() => validateCreativeProofCopyConsistency(snapshot, {
      ...valid,
      copy: { ...valid.copy, primaryText: 'Broader rewritten claim.' },
      adCopy: { ...valid.adCopy, primaryText: 'Broader rewritten claim.' },
    })).toThrow('no longer contains the exact selected Proof text');
  });

  it('keeps no-Proof legacy work compatible', async () => {
    await expect(revalidateSelectedProofForPaidWork(undefined)).resolves.toBeUndefined();
    await expect(revalidateSelectedProofForPaidWork(null)).resolves.toBeUndefined();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
