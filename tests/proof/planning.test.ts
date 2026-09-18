import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaseStudyProofRecord, ProofRecord, ReviewProofRecord } from '@/lib/proof/types';

const { listProofRecordsMock } = vi.hoisted(() => ({
  listProofRecordsMock: vi.fn(async (): Promise<ProofRecord[]> => []),
}));
vi.mock('@/lib/proof/storage', () => ({ listProofRecords: listProofRecordsMock }));

import {
  MAX_PLANNING_PROOF_RECORDS,
  MAX_PLANNING_PROOF_SERIALIZED_CHARS,
  selectProofForPlanning,
} from '@/lib/proof/planning';
import { requestCreativeBatch } from '@/lib/ai/creative-planner';
import { conceptDetails } from '../fixtures/creative-concept-details';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { parseCreativePortfolioJob } from '@/lib/creatives/portfolio-job-parser';
import { portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';
import { portfolioAudit } from '../fixtures/portfolio-audit';

const review = (hex: string, overrides: Partial<ReviewProofRecord> = {}): ReviewProofRecord => ({
  id: `proof_${hex.repeat(32)}`,
  type: 'review',
  originalReviewText: '  Exact review—unchanged.\nSecond line.  ',
  tags: ['bank levy'],
  status: 'ACTIVE',
  advertisingUseApproved: true,
  createdAt: '2026-09-10T12:00:00.000Z',
  updatedAt: '2026-09-10T12:00:00.000Z',
  ...overrides,

});

const caseStudy = (hex: string, overrides: Partial<CaseStudyProofRecord> = {}): CaseStudyProofRecord => ({
  id: `proof_${hex.repeat(32)}`,
  type: 'case-study',
  title: 'Bank levy case study',
  verifiedFacts: ['SOURCE_ONLY_VERIFIED_FACT'],
  approvedClaimWording: 'Approved source-bound claim wording.',
  sourceNote: 'Internal source note.',
  usageRestrictions: 'Use only for bank-levy messaging.',
  requiredDisclaimer: 'Results vary by circumstances.',
  tags: ['bank levy'],
  status: 'ACTIVE',
  advertisingUseApproved: true,
  createdAt: '2026-09-10T12:00:00.000Z',
  updatedAt: '2026-09-10T13:00:00.000Z',
  ...overrides,
});

const analysis = {
  summary: 'Clear hierarchy', visibleText: [], visualStructure: 'Headline over graphic',
  hookOrAngle: 'Bank levy concern', offerOrCta: 'Talk with TRA', styleNotes: 'Calm',
  preserve: ['hierarchy'], avoid: ['unsupported claims'], unknowns: [],
  dominantCategory: 'customer-problems' as const,
};

const strategy = {
  conceptDetails,
  category: 'customer-problems', awarenessStage: 'problem-aware',
  persona: 'Taxpayer facing a bank levy', painPoint: 'Bank levy concern',
  desiredOutcome: 'Clear next steps', emotion: 'Relief', hook: 'Understand the next step',
  cta: 'Talk with TRA', offer: null,
  soWhat: {
    surfaceMessage: 'Understand the issue',
    functionalConsequence: 'Know the next step',
    meaningfulOutcome: 'Move forward with confidence',
  },
  execution: {
    taxDocumentReference: 'none', subjectSource: 'non-human', composition: 'single-focus',
    imageTreatment: 'minimal-graphic', textDensity: 'low', ctaTreatment: 'button',
    typographyHierarchy: 'headline-dominant',
  },
  visualDirection: 'A restrained non-human bank-levy concept',
};

const concept = (index: number) => ({
  index,
  format: index === 1 ? 'educational' : 'proof',
  adCopy: { primaryText: `Primary ${index}`, headline: `Headline ${index}`, description: '' },
  imageCopy: {
    headline: `Image headline ${index}`, shortSupport: null, proofAttribution: null,
    cta: null, disclosure: null,
  },
  proofSelection: null,
  strategy: {
    ...strategy,
    conceptDetails: { ...conceptDetails, proposition: `Distinct proposition ${index}` },
    soWhat: { ...strategy.soWhat, surfaceMessage: `Distinct surface ${index}` },
  },
  selectionReason: `Distinct reason ${index}`,
});

const okResponse = (value: unknown) => new Response(JSON.stringify({
  status: 'completed',
  output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
}), { status: 200 });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  listProofRecordsMock.mockReset();
  listProofRecordsMock.mockResolvedValue([]);
});

describe('Proof planning retrieval', () => {
  it('preserves an approved ACTIVE Review exactly and gates attribution', () => {
    const attributed = review('a', { attribution: { display: 'Sam', allowed: true } });
    const unattributed = review('b', {
      originalReviewText: 'Bank levy help without approved attribution.',
      attribution: undefined,
    });

    const result = selectProofForPlanning([attributed, unattributed], 'Need a bank levy proof concept');

    expect(result).toHaveLength(2);
    expect(result.find(item => item.id === attributed.id)).toMatchObject({
      id: attributed.id,
      type: 'review',
      updatedAt: attributed.updatedAt,
      tags: attributed.tags,
      originalReviewText: attributed.originalReviewText,
      attribution: attributed.attribution,
    });
    expect(result.find(item => item.id === unattributed.id)).not.toHaveProperty('attribution');
  });

  it('carries only approved Case Study wording, restrictions and disclaimer', () => {
    const source = caseStudy('c');
    const [result] = selectProofForPlanning([source], 'Bank levy case study proof');

    expect(result).toEqual({
      id: source.id,
      type: 'case-study',
      updatedAt: source.updatedAt,
      tags: source.tags,
      title: source.title,
      approvedClaimWording: source.approvedClaimWording,
      usageRestrictions: source.usageRestrictions,
      requiredDisclaimer: source.requiredDisclaimer,
    });
    expect(result).not.toHaveProperty('verifiedFacts');
    expect(result).not.toHaveProperty('sourceNote');
  });

  it('excludes unapproved, legacy approval-absent and INACTIVE records', () => {
    const legacy = review('e');
    delete legacy.advertisingUseApproved;
    expect(selectProofForPlanning([
      review('d', { advertisingUseApproved: false }),
      legacy,
      review('f', { status: 'INACTIVE' }),
    ], 'Bank levy proof')).toEqual([]);
  });

  it('keeps relevant retrieval deterministic and bounded', () => {
    const records = '0123456789ab'.split('').map((hex, index) => review(hex, {
      originalReviewText: `Bank levy review ${index}`,
      updatedAt: `2026-09-10T12:00:${String(index).padStart(2, '0')}.000Z`,
    }));

    const first = selectProofForPlanning(records, 'bank levy');
    expect(first).toEqual(selectProofForPlanning([...records].reverse(), 'bank levy'));
    expect(first).toHaveLength(MAX_PLANNING_PROOF_RECORDS);
    expect(first.reduce((sum, item) => sum + JSON.stringify(item).length, 0))
      .toBeLessThanOrEqual(MAX_PLANNING_PROOF_SERIALIZED_CHARS);
  });

  it('returns no Proof when nothing eligible is relevant', () => {
    expect(selectProofForPlanning([
      review('a', { tags: ['professional'], originalReviewText: 'Clear and patient service.' }),
    ], 'wage garnishment notice')).toEqual([]);
    expect(selectProofForPlanning([], 'bank levy')).toEqual([]);
  });

  it('sends Astra only eligible Proof records and never verifiedFacts', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const approvedReview = review('a', { attribution: { display: 'Sam', allowed: true } });
    const approvedCase = caseStudy('b');
    const legacy = review('c');
    delete legacy.advertisingUseApproved;
    listProofRecordsMock.mockResolvedValue([
      approvedReview,
      approvedCase,
      review('d', { advertisingUseApproved: false }),
      review('e', { status: 'INACTIVE' }),
      legacy,
    ]);

    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      okResponse({ creatives: [concept(1), concept(2)] }));
    vi.stubGlobal('fetch', fetchMock);

    await requestCreativeBatch({
      count: 2,
      context: 'Planner context may include company and repair material',
      proofRetrievalQuery: 'Create bank levy proof concepts',
      analysis,
      hasApprovedHumanSource: false,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1];
    const body = JSON.parse(String(init?.body));
    const input = JSON.parse(body.input[1].content[0].text);
    expect(input.proofCatalog.map((item: { id: string }) => item.id))
      .toEqual([approvedCase.id, approvedReview.id]);
    expect(JSON.stringify(input.proofCatalog)).not.toContain('SOURCE_ONLY_VERIFIED_FACT');
    expect(JSON.stringify(input.proofCatalog)).not.toContain(legacy.id);
    expect(body.input[0].content[0].text).toContain('whole review-line boundaries');
    expect(body.input[0].content[0].text).toContain('proofSelection:null means no supplied Proof wording or attribution');
    expect(body.input[0].content[0].text).toContain('never broaden it into a universal outcome');
  });
  it('fails closed when ad-facing Proof text is used without the matching selection', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const reviewSource = review('a', { originalReviewText: 'I did not save $10,000.' });
    const caseSource = caseStudy('b');
    listProofRecordsMock.mockResolvedValue([reviewSource, caseSource]);

    const reviewBypass = {
      ...concept(1),
      adCopy: { ...concept(1).adCopy, primaryText: reviewSource.originalReviewText },
      proofSelection: null,
    };
    vi.stubGlobal('fetch', vi.fn(async () =>
      okResponse({ creatives: [reviewBypass, concept(2)] })));
    await expect(requestCreativeBatch({
      count: 2,
      context: 'Planner context',
      proofRetrievalQuery: 'bank levy',
      analysis,
      hasApprovedHumanSource: false,
    })).rejects.toThrow('invalid creative batch plan concept');

    const caseBypass = {
      ...concept(1),
      imageCopy: { ...concept(1).imageCopy, headline: caseSource.approvedClaimWording },
      proofSelection: null,
    };
    vi.stubGlobal('fetch', vi.fn(async () =>
      okResponse({ creatives: [caseBypass, concept(2)] })));
    await expect(requestCreativeBatch({
      count: 2,
      context: 'Planner context',
      proofRetrievalQuery: 'bank levy',
      analysis,
      hasApprovedHumanSource: false,
    })).rejects.toThrow('invalid creative batch plan concept');
  });

  it('fails closed on shortened Review, Case Study, and disclaimer fragments without matching selection', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const reviewSource = review('a', { originalReviewText: 'I did not save $10,000.' });
    const caseSource = caseStudy('b', {
      approvedClaimWording: 'TRA helped the client understand the next steps clearly.',
      requiredDisclaimer: 'Results vary based on each client circumstances.',
    });
    listProofRecordsMock.mockResolvedValue([reviewSource, caseSource]);

    const variants = [
      { ...concept(1), adCopy: { ...concept(1).adCopy, primaryText: 'save $10,000' } },
      { ...concept(1), imageCopy: { ...concept(1).imageCopy, shortSupport: 'understand the next steps clearly' } },
      { ...concept(1), imageCopy: { ...concept(1).imageCopy, disclosure: caseSource.requiredDisclaimer } },
    ];
    for (const invalid of variants) {
      vi.stubGlobal('fetch', vi.fn(async () =>
        okResponse({ creatives: [invalid, concept(2)] })));
      await expect(requestCreativeBatch({
        count: 2,
        context: 'Planner context',
        proofRetrievalQuery: 'bank levy',
        analysis,
        hasApprovedHumanSource: false,
      })).rejects.toThrow('invalid creative batch plan concept');
    }
  });

  it('rejects context-stripped Review selections and accepts the full source-bound line', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const source = review('a', { originalReviewText: 'I did not save $10,000.' });
    listProofRecordsMock.mockResolvedValue([source]);

    const unsafe = {
      ...concept(1),
      adCopy: { ...concept(1).adCopy, primaryText: 'save $10,000.' },
      proofSelection: {
        type: 'review',
        proofId: source.id,
        proofUpdatedAt: source.updatedAt,
        selectedText: 'save $10,000.',
        includeAttribution: false,
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ creatives: [unsafe, concept(2)] })));
    await expect(requestCreativeBatch({
      count: 2,
      context: 'Planner context',
      proofRetrievalQuery: 'bank levy',
      analysis,
      hasApprovedHumanSource: false,
    })).rejects.toThrow('invalid creative batch plan concept');

    const safe = {
      ...concept(1),
      adCopy: { ...concept(1).adCopy, primaryText: source.originalReviewText },
      proofSelection: {
        type: 'review',
        proofId: source.id,
        proofUpdatedAt: source.updatedAt,
        selectedText: source.originalReviewText,
        includeAttribution: false,
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ creatives: [safe, concept(2)] })));
    const result = await requestCreativeBatch({
      count: 2,
      context: 'Planner context',
      proofRetrievalQuery: 'bank levy',
      analysis,
      hasApprovedHumanSource: false,
    });
    expect(result.creatives[0].selectedProof?.selectedText).toBe(source.originalReviewText);
  });

  it('fails the whole planner response closed when a selection is not valid for that call catalog', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const source = review('a');
    listProofRecordsMock.mockResolvedValue([source]);
    const invalid = {
      ...concept(1),
      proofSelection: {
        type: 'review',
        proofId: `proof_${'f'.repeat(32)}`,
        proofUpdatedAt: source.updatedAt,
        selectedText: 'Second line.',
        includeAttribution: false,
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () =>
      okResponse({ creatives: [invalid, concept(2)] })));

    await expect(requestCreativeBatch({
      count: 2,
      context: 'Planner context',
      proofRetrievalQuery: 'bank levy',
      analysis,
      hasApprovedHumanSource: false,
    })).rejects.toThrow('invalid creative batch plan concept');
  });

  it('hydrates selected Proof into durable checkpoint and audited reload state', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const source = caseStudy('b');
    listProofRecordsMock.mockResolvedValue([source]);
    const selected = {
      type: 'case-study' as const,
      proofId: source.id,
      proofUpdatedAt: source.updatedAt,
      selectedText: source.approvedClaimWording,
    };
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ creatives: [
      {
        ...concept(1),
        adCopy: { ...concept(1).adCopy, primaryText: source.approvedClaimWording },
        imageCopy: { ...concept(1).imageCopy, disclosure: source.requiredDisclaimer },
        proofSelection: selected,
      },
      concept(2),
    ] })));

    const proofRetrievalQuery = 'bank levy';
    const plannerArgs = {
      count: 2,
      context: 'Frozen planner context',
      proofRetrievalQuery,
      analysis,
      hasApprovedHumanSource: false,
    };
    const batchPlan = await requestCreativeBatch(plannerArgs);
    expect(batchPlan.creatives[0].selectedProof).toEqual({
      ...selected,
      type: 'case-study',
      usageRestrictions: source.usageRestrictions,
      requiredDisclaimer: source.requiredDisclaimer,
    });
    expect(JSON.stringify(batchPlan.creatives[0].selectedProof)).not.toContain('SOURCE_ONLY_VERIFIED_FACT');

    const job = newCreativePortfolio({ ...portfolioRequest(), proofRetrievalQuery });
    job.planning = {
      phase: 'DIVERSITY_AUDIT',
      repairAttempted: false,
      checkpoint: {
        plannerArgs,
        snapshot: { ...portfolioSnapshot(job), batchPlan },
      },
    };
    const checkpointReload = parseCreativePortfolioJob(
      Buffer.from(JSON.stringify(job)),
      job.id
    );
    if (checkpointReload.planning.phase !== 'DIVERSITY_AUDIT') {
      throw new Error('Expected diversity-audit checkpoint.');
    }
    expect(checkpointReload.planning.checkpoint.snapshot.batchPlan.creatives[0].selectedProof)
      .toEqual(batchPlan.creatives[0].selectedProof);

    const audited = structuredClone(job);
    audited.planning = { phase: 'READY_TO_RENDER' };
    audited.snapshot = {
      ...portfolioSnapshot(audited),
      batchPlan: { ...batchPlan, portfolioAudit: portfolioAudit(2) },
    };
    const auditedReload = parseCreativePortfolioJob(
      Buffer.from(JSON.stringify(audited)),
      audited.id
    );
    expect(auditedReload.snapshot?.batchPlan.creatives[0].selectedProof)
      .toEqual(batchPlan.creatives[0].selectedProof);
  });
});
