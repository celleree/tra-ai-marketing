import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewProofRecord, CaseStudyProofRecord } from '@/lib/proof/types';
import { reviewSourceSha256 } from '@/lib/video/review-selection';
const mocks = vi.hoisted(() => ({ proofs: vi.fn(), access: vi.fn() }));
vi.mock('@/lib/proof/storage', () => ({ listProofRecords: mocks.proofs }));
vi.mock('@/lib/auth/require-operator', () => ({ requireOperatorAccess: mocks.access }));
import { discoverReviewStatements } from '@/lib/video/review-statement-discovery';
import { POST } from '@/app/api/video/review-sources/route';
const profile = { knowledgeBase: { servicesOffers: 'Battery backup included.' }, guardrails: { requiredDisclaimers: 'Offer conditions apply.' } };
const base = { status: 'ACTIVE', advertisingUseApproved: false, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', tags: [] as string[] } as const;
const review: ReviewProofRecord = { ...base, id: `proof_${'a'.repeat(32)}`, type: 'review', originalReviewText: '  Best decision we made for the house.  ', source: 'Customer email' };
const caseStudy: CaseStudyProofRecord = { ...base, id: `proof_${'b'.repeat(32)}`, type: 'case-study', title: 'Smith Residence',
  verifiedFacts: ['Installation was completed in two weeks.'], approvedClaimWording: 'Energy bill reduced.', sourceNote: 'Final project report',
  requiredDisclaimer: 'Results vary.', usageRestrictions: 'Residential examples only.' };
const request = (body: unknown) => new Request('http://localhost/api/video/review-sources', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('NODE_ENV', 'test'); mocks.access.mockResolvedValue(null); mocks.proofs.mockResolvedValue([review, caseStudy]);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network/provider calls allowed'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('read-only exact statement discovery', () => {
  it('reuses exact Review/Case Study/Profile refs, full wording, qualifiers and snapshot hashes without approval', async () => {
    const result = await discoverReviewStatements(profile);
    expect(result.companyProfile).toEqual(profile);
    expect(result.statements.map(statement => statement.wording)).toEqual([review.originalReviewText, caseStudy.approvedClaimWording,
      caseStudy.verifiedFacts[0], profile.knowledgeBase.servicesOffers]);
    expect(result.statements[0].reference).toMatchObject({ type: 'PROOF', proofId: review.id, recordSha256: reviewSourceSha256(review), start: 0, end: review.originalReviewText.length });
    expect(result.statements[1].context).toMatchObject({ record: { requiredDisclaimer: 'Results vary.', usageRestrictions: 'Residential examples only.', advertisingUseApproved: false } });
    expect(result.statements[3]).toMatchObject({ reference: { profileSha256: reviewSourceSha256(profile) }, context: { guardrails: profile.guardrails } });
  });
  it('omits inactive and blank records/fields and never treats guardrail instructions as statements', async () => {
    mocks.proofs.mockResolvedValue([{ ...review, status: 'INACTIVE' }, { ...caseStudy, approvedClaimWording: ' ', verifiedFacts: [] }]);
    expect((await discoverReviewStatements({ guardrails: { neverSay: 'Do not guarantee savings.' } })).statements).toEqual([]);
  });
  it('accepts a saved operator snapshot without normalizing its wording and rejects ordinary malformed profiles', async () => {
    expect((await discoverReviewStatements({ knowledgeBase: { servicesOffers: '  Exact wording.  ' } })).statements.at(-1)!.wording).toBe('  Exact wording.  ');
    await expect(discoverReviewStatements({ knowledgeBase: { unexpected: 'Invalid field' } })).rejects.toMatchObject({ status: 400 });
  });
  it('requires existing operator access and reports source failures while retaining private no-store responses', async () => {
    mocks.access.mockResolvedValue(new Response('Denied', { status: 401 })); expect((await POST(request({ companyProfile: profile }))).status).toBe(401);
    expect(mocks.proofs).not.toHaveBeenCalled(); mocks.access.mockResolvedValue(null);
    expect((await POST(request({ companyProfile: profile, typo: true }))).status).toBe(400);
    const response = await POST(request({ companyProfile: profile })); expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    mocks.proofs.mockRejectedValue(new Error('Storage unavailable')); expect((await POST(request({ companyProfile: profile }))).status).toBe(503);
  });
});
