import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '@/lib/company/profile';
import { readStoredRuntimeCompanyProfile } from '@/lib/company/creative-context';
import { readStoredBrandLogo } from '@/lib/creatives/brand-logo';
import { readStoredBrandGuidance } from '@/lib/creatives/brand-guidance';
import { readSelectedCompanyReferenceIds, setSelectedCompanyReferenceIds } from '@/lib/company/reference-selection';
import { validateGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import { loadApprovedHumanOptions } from '@/lib/video/approved-human-planning';
import { loadPlanningProofCatalog } from '@/lib/proof/planning';

afterEach(() => vi.unstubAllGlobals());
const browserStore = () => {
  const data = new Map<string, string>();
  const localStorage = { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); } };
  vi.stubGlobal('window', { localStorage }); vi.stubGlobal('localStorage', localStorage);
  return data;
};
const id = `media_${'a'.repeat(32)}`;
const body = { context: 'Create an informative tax-service concept.', variationCount: 2, peoplePercent: 0, useReferenceLibrary: false };
describe('company-neutral new work', () => {
  it('keeps genuine audience guidance but supplies no identity, offers, proof, contacts or brand', () => {
    expect(DEFAULT_COMPANY_PROFILE.knowledgeBase).toMatchObject({ companySummary: '', servicesOffers: '', proof: '', differentiators: '', faqsFacts: '' });
    expect(DEFAULT_COMPANY_PROFILE.brandGuidelines).toMatchObject({ logo: '', brandColors: '', fonts: '' });
    expect(DEFAULT_COMPANY_PROFILE.guardrails.approvedClaims).toBe('');
    expect(DEFAULT_COMPANY_PROFILE.knowledgeBase.customerProblems).toContain('IRS notices');
    expect(JSON.stringify(DEFAULT_COMPANY_PROFILE)).not.toMatch(/Tax Relief Advocates|\bTRA\b|tra\.com|Free\/no-cost|800-501/);
  });
  it('leaves the legacy browser profile untouched and ignores its logo and claims', () => {
    const store = browserStore(); const legacy = JSON.stringify({ knowledgeBase: { companySummary: 'Old TRA facts' }, brandGuidelines: { logo: `/api/media/files/${id}.png` } });
    store.set('tra-company-profile-v2', legacy);
    expect(readStoredRuntimeCompanyProfile()).toBeUndefined();
    expect(readStoredBrandGuidance().logo).toBeNull();
    expect(readStoredBrandLogo()).toBeNull();
    expect(store.get('tra-company-profile-v2')).toBe(legacy);
    store.set('tax-marketing-studio:company-profile:v1', JSON.stringify({ knowledgeBase: { companySummary: 'Own company' }, brandGuidelines: { logo: `/api/media/files/${id}.png` } }));
    expect(readStoredRuntimeCompanyProfile()?.knowledgeBase?.companySummary).toBe('Own company');
    expect(readStoredBrandGuidance().logo?.mediaId).toBe(id);
    expect(readStoredBrandLogo()?.mediaId).toBe(id);
  });
  it('starts with no implicitly selected shared references and round-trips explicit valid choices', () => {
    browserStore(); expect(readSelectedCompanyReferenceIds()).toEqual([]);
    setSelectedCompanyReferenceIds([id, id, 'invalid']);
    expect(readSelectedCompanyReferenceIds()).toEqual([id]);
    setSelectedCompanyReferenceIds([]); expect(readSelectedCompanyReferenceIds()).toEqual([]);
  });
  it('marks even old clients as fresh source-scoped admissions without inventing a logo', () => {
    const result = validateGenerateCreativeRequest(body); if (!result.success) throw new Error(result.error);
    expect(result.data.companySourceScope).toEqual({ version: 1, referenceIds: [] });
    expect(result.data.brandLogoMediaId).toBeUndefined();
    expect(result.data.context).toContain('create unbranded generic tax-service concepts');
    expect(validateGenerateCreativeRequest({ ...body, companySourceScope: { version: 1, referenceIds: [id] } }).success).toBe(true);
  });
  it.each([{ version: 2, referenceIds: [] }, { version: 1, referenceIds: ['invalid'] }, { version: 1, referenceIds: [id, id] }, null])('rejects an invalid source selection without widening it', companySourceScope => {
    expect(validateGenerateCreativeRequest({ ...body, companySourceScope }).success).toBe(false);
  });
  it('does not access remote shared human or Proof catalogs when none are selected', async () => {
    const fetch = vi.fn(() => { throw new Error('Unexpected remote access'); }); vi.stubGlobal('fetch', fetch);
    expect(await loadApprovedHumanOptions([])).toEqual([]);
    expect(await loadPlanningProofCatalog('tax', [])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
