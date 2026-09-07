import { describe, expect, it } from 'vitest';
import { validateCreativeRevisionRequest } from '@/lib/creatives/revision-request';
import { CREATIVE_PLACEMENTS } from '@/lib/creatives/placements';

describe('saved creative revision requests', () => {
  it.each(['EDIT', 'VARIATION'])('normalizes an explicit %s instruction and approved company context', (operation) => {
    expect(validateCreativeRevisionRequest({ operation, instruction: '  Use a clearer headline  ', companyProfile: { guardrails: { approvedClaims: ' Approved claim ', unknown: 'ignored' } } })).toEqual({
      success: true, data: { operation, instruction: 'Use a clearer headline', companyProfile: { guardrails: { approvedClaims: 'Approved claim' } } },
    });
  });

  it.each(CREATIVE_PLACEMENTS)('requires an explicit target for %s variants', (placement) => {
    expect(validateCreativeRevisionRequest({ operation: 'PLACEMENT', placement })).toEqual({ success: true, data: { operation: 'PLACEMENT', placement } });
  });

  it('accepts regeneration without changes and does not synthesize a company profile', () => {
    expect(validateCreativeRevisionRequest({ operation: 'REGENERATE' })).toEqual({ success: true, data: { operation: 'REGENERATE' } });
  });

  it.each([
    null, [], 'EDIT', {}, { operation: 'GENERATE' },
    { operation: 'EDIT' }, { operation: 'EDIT', instruction: '   ' },
    { operation: 'VARIATION', instruction: 'x'.repeat(4001) },
    { operation: 'REGENERATE', instruction: 'Change the claim' },
    { operation: 'EDIT', instruction: 'Change color', placement: 'SQUARE_1_1' },
    { operation: 'PLACEMENT' }, { operation: 'PLACEMENT', placement: 'LANDSCAPE' },
    { operation: 'REGENERATE', identity: { conceptId: 'caller-value' } },
    { operation: 'REGENERATE', sourceAssets: [] },
    { operation: 'REGENERATE', companyProfile: 'invalid' },
    { operation: 'REGENERATE', companyProfile: null },
  ])('rejects malformed or ambiguous operation input %#', (input) => {
    expect(validateCreativeRevisionRequest(input).success).toBe(false);
  });
});
