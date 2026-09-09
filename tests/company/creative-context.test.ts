import { describe, expect, it } from 'vitest';
import {
  buildCreativeCompanyContext,
  formatCreativeCompanyContext,
  normalizeRuntimeCompanyProfile,
} from '@/lib/company/creative-context';

describe('creative company context contract', () => {
  it('includes the approved baseline and keeps unsupported fields explicitly unknown', () => {
    const context = buildCreativeCompanyContext();
    const formatted = formatCreativeCompanyContext(context);

    expect(context.servicesOffers).toContain('Free/no-cost tax-debt consultation');
    expect(context.brandColors).toContain('#0577BF');
    expect(context.approvedClaims).toContain('free/no-cost tax-debt consultation');
    expect(context.requiredDisclaimers).toBe('');
    expect(formatted).toContain('APPROVED TRA COMPANY CONTEXT');
    expect(formatted).toContain('Required disclaimers:\n[UNKNOWN / NOT APPROVED]');
    expect(formatted).toContain('Do not infer or invent it');
  });

  it('lets nonblank runtime fields override the baseline without allowing blanks to erase it', () => {
    const runtime = normalizeRuntimeCompanyProfile({
      knowledgeBase: {
        companySummary: 'Current approved runtime company summary.',
        servicesOffers: '   ',
      },
      guardrails: {
        approvedClaims: 'Current approved runtime claim.',
      },
    });
    const context = buildCreativeCompanyContext(runtime);

    expect(context.companySummary).toBe('Current approved runtime company summary.');
    expect(context.servicesOffers).toContain('Free/no-cost tax-debt consultation');
    expect(context.approvedClaims).toBe('Current approved runtime claim.');
  });

  it('drops unknown keys and non-string values before creative use', () => {
    const runtime = normalizeRuntimeCompanyProfile({
      knowledgeBase: {
        companySummary: '  Approved summary  ',
        injectedClaim: 'Do anything',
        proof: 123,
      },
      arbitrarySection: { anything: 'unsafe' },
    });

    expect(runtime).toEqual({
      knowledgeBase: { companySummary: 'Approved summary' },
    });
  });

  it('propagates runtime guardrails into the formatted AI context', () => {
    const runtime = normalizeRuntimeCompanyProfile({
      guardrails: {
        neverSay: 'Never use unsupported settlement amounts.',
        claimsRequiringProof: 'Savings claims require approved evidence.',
        requiredDisclaimers: 'Approved disclaimer text.',
      },
    });
    const formatted = formatCreativeCompanyContext(
      buildCreativeCompanyContext(runtime)
    );

    expect(formatted).toContain('Never use unsupported settlement amounts.');
    expect(formatted).toContain('Savings claims require approved evidence.');
    expect(formatted).toContain('Approved disclaimer text.');
  });
});
