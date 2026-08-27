import { describe, expect, it } from 'vitest';
import { validateGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import {
  isApprovedHumanSourceRole,
  isUsableApprovedHumanSource,
  type CreativeSourceRole,
} from '@/lib/media/types';

const makeMediaId = (hex: string) => `media_${hex.repeat(32)}`;

const makeSource = (
  role: CreativeSourceRole,
  hex: string
) => ({ role, mediaId: makeMediaId(hex) });

const baseRequest = {
  context: 'Create compliant TRA concepts.',
  variationCount: 4,
};

const expectGroundedContext = (value: unknown) => {
  expect(value).toEqual(expect.stringContaining('USER CREATIVE DIRECTION:'));
  expect(value).toEqual(expect.stringContaining(baseRequest.context));
  expect(value).toEqual(expect.stringContaining('APPROVED TRA COMPANY CONTEXT'));
  expect(value).toEqual(expect.stringContaining('Free/no-cost tax-debt consultation'));
};

describe('multi-source creative generation request', () => {
  it('preserves multiple typed image and video sources in request order', () => {
    const sourceAssets = [
      makeSource('TRA_VIDEO', 'a'),
      makeSource('TRA_REFERENCE', 'b'),
      makeSource('LAYOUT_REFERENCE', 'c'),
    ];

    const result = validateGenerateCreativeRequest({
      ...baseRequest,
      sourceAssets,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sourceAssets).toEqual(sourceAssets);
    expect(result.data.variationCount).toBe(baseRequest.variationCount);
    expectGroundedContext(result.data.context);
  });

  it('normalizes an omitted source collection to an empty array', () => {
    const result = validateGenerateCreativeRequest(baseRequest);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sourceAssets).toEqual([]);
    expectGroundedContext(result.data.context);
  });

  it('normalizes runtime company profile and grounds it into the AI context', () => {
    const result = validateGenerateCreativeRequest({
      ...baseRequest,
      companyProfile: {
        knowledgeBase: {
          companySummary: 'Runtime approved TRA summary.',
          servicesOffers: '   ',
          injectedClaim: 'Unrecognized field must be dropped.',
        },
        guardrails: {
          approvedClaims: 'Runtime approved claim.',
          requiredDisclaimers: 'Runtime approved disclaimer.',
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.companyProfile).toEqual({
      knowledgeBase: { companySummary: 'Runtime approved TRA summary.' },
      guardrails: {
        approvedClaims: 'Runtime approved claim.',
        requiredDisclaimers: 'Runtime approved disclaimer.',
      },
    });
    expect(result.data.context).toContain('Runtime approved TRA summary.');
    expect(result.data.context).toContain('Runtime approved claim.');
    expect(result.data.context).toContain('Runtime approved disclaimer.');
    expect(result.data.context).toContain('Free/no-cost tax-debt consultation');
    expect(result.data.context).not.toContain('Unrecognized field must be dropped.');
  });

  it.each([null, [], 'invalid'])('rejects malformed companyProfile %#', (companyProfile) => {
    expect(
      validateGenerateCreativeRequest({ ...baseRequest, companyProfile })
    ).toEqual({ success: false, error: 'companyProfile must be an object' });
  });

  it.each(['INVALID', '', 'TRA-REFERENCE'])('rejects invalid roles', (role) => {
    expect(
      validateGenerateCreativeRequest({
        ...baseRequest,
        sourceAssets: [{ mediaId: makeMediaId('a'), role }],
      })
    ).toEqual({
      success: false,
      error: 'sourceAssets contains an invalid role',
    });
  });

  it('rejects duplicate media identities as ambiguous provenance', () => {
    const result = validateGenerateCreativeRequest({
      ...baseRequest,
      sourceAssets: [
        makeSource('TRA_REFERENCE', 'd'),
        makeSource('LAYOUT_REFERENCE', 'd'),
      ],
    });

    expect(result).toEqual({
      success: false,
      error: 'sourceAssets contains duplicate media IDs',
    });
  });

  it('rejects the replaced ambiguous mediaId/uploadMode contract', () => {
    const result = validateGenerateCreativeRequest({
      ...baseRequest,
      mediaId: makeMediaId('e'),
      uploadMode: 'reference',
    });

    expect(result).toEqual({
      success: false,
      error: 'Use sourceAssets with explicit source roles instead of mediaId/uploadMode',
    });
  });

  it('rejects client-asserted stored-media metadata', () => {
    const source = {
      ...makeSource('TRA_REFERENCE', 'f'),
      media: {
        mimeType: 'image/png',
        size: 1,
        url: 'https://client.invalid/source.png',
      },
    };

    expect(
      validateGenerateCreativeRequest({ ...baseRequest, sourceAssets: [source] })
    ).toEqual({
      success: false,
      error: 'sourceAssets accepts only mediaId and role',
    });
  });
});

describe('approved human source invariant', () => {
  it('allows only TRA video and TRA reference roles as human sources', () => {
    expect(isApprovedHumanSourceRole('TRA_VIDEO')).toBe(true);
    expect(isApprovedHumanSourceRole('TRA_REFERENCE')).toBe(true);
    expect(isApprovedHumanSourceRole('LAYOUT_REFERENCE')).toBe(false);
  });

  it('requires an approved TRA source to be actually supplied to image generation', () => {
    const layout = makeSource('LAYOUT_REFERENCE', 'f');
    const traImage = makeSource('TRA_REFERENCE', 'a');
    const traVideo = makeSource('TRA_VIDEO', 'b');

    expect(isUsableApprovedHumanSource(layout, true)).toBe(false);
    expect(isUsableApprovedHumanSource(traImage, false)).toBe(false);
    expect(isUsableApprovedHumanSource(traVideo, false)).toBe(false);
    expect(isUsableApprovedHumanSource(traImage, true)).toBe(true);
  });
});
