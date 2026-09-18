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
    expect(body.input[0].content[0].text).toContain('quote it only verbatim');
    expect(body.input[0].content[0].text).toContain('never broaden it into a universal outcome');
  });
});
