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

const videoFrameSelection = {
  libraryId: `video-library:${'a'.repeat(64)}`,
  sourceVideoContentHash: 'b'.repeat(64),
  frameIds: [`video-frame:${'c'.repeat(64)}`],
};

const expectGroundedContext = (value: unknown) => {
  expect(value).toEqual(expect.stringContaining('USER CREATIVE DIRECTION:'));
  expect(value).toEqual(expect.stringContaining(baseRequest.context));
  expect(value).toEqual(expect.stringContaining('APPROVED TRA COMPANY CONTEXT'));
  expect(value).toEqual(expect.stringContaining('Free/no-cost tax-debt consultation'));
};

describe('multi-source creative generation request', () => {
  it('keeps the legacy ceiling while allowing the resumable caller to opt into 36', () => {
    const request = { ...baseRequest, variationCount: 36 };
    expect(validateGenerateCreativeRequest(request)).toEqual({ success: false, error: 'variationCount must be an integer between 2 and 30' });
    expect(validateGenerateCreativeRequest(request, 36).success).toBe(true);
    expect(validateGenerateCreativeRequest({ ...request, variationCount: 37 }, 36).success).toBe(false);
  });
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
    expect(result.data.placement).toBe('SQUARE_1_1');
    expectGroundedContext(result.data.context);
  });

  it('accepts a 4000-character trimmed creative direction', () => {
    const direction = 'x'.repeat(4000);
    const result = validateGenerateCreativeRequest({
      ...baseRequest,
      context: `  ${direction}  `,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.context).toContain(direction);
    expect(result.data.context).not.toContain(`  ${direction}  `);
  });

  it('rejects a creative direction longer than 4000 characters after trimming', () => {
    expect(
      validateGenerateCreativeRequest({
        ...baseRequest,
        context: `  ${'x'.repeat(4001)}  `,
      })
    ).toEqual({
      success: false,
      error: 'context must be 4000 characters or fewer',
    });
  });

  it('keeps whitespace-only creative direction validation as required context', () => {
    expect(
      validateGenerateCreativeRequest({ ...baseRequest, context: '   ' })
    ).toEqual({ success: false, error: 'context is required' });
  });

  it('accepts a supported requested placement', () => {
    const result = validateGenerateCreativeRequest({
      ...baseRequest,
      placement: 'PORTRAIT_4_5',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.placement).toBe('PORTRAIT_4_5');
  });

  it.each([null, '', 'LANDSCAPE_16_9'])('rejects unsupported placement %j', (placement) => {
    expect(validateGenerateCreativeRequest({ ...baseRequest, placement })).toEqual({
      success: false,
      error: 'placement is unsupported',
    });
  });

  it('accepts a strict selected-frame contract for exactly one TRA video', () => {
    const sourceAssets = [makeSource('TRA_VIDEO', 'a')];
    const result = validateGenerateCreativeRequest({
      ...baseRequest,
      sourceAssets,
      videoFrameSelection,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.videoFrameSelection).toEqual(videoFrameSelection);
  });

  it.each([
    null,
    { ...videoFrameSelection, extra: true },
    { ...videoFrameSelection, libraryId: 'library' },
    { ...videoFrameSelection, sourceVideoContentHash: 'ABC' },
    { ...videoFrameSelection, frameIds: [] },
    { ...videoFrameSelection, frameIds: Array(4).fill(`video-frame:${'c'.repeat(64)}`) },
    { ...videoFrameSelection, frameIds: [`video-frame:${'c'.repeat(64)}`, `video-frame:${'c'.repeat(64)}`] },
  ])('rejects malformed selected-frame metadata %#', (selection) => {
    const result = validateGenerateCreativeRequest({
      ...baseRequest,
      sourceAssets: [makeSource('TRA_VIDEO', 'a')],
      videoFrameSelection: selection,
    });

    expect(result).toEqual({
      success: false,
      error:
        'videoFrameSelection must contain a valid libraryId, sourceVideoContentHash, and 1 to 3 unique frameIds',
    });
  });

  it.each([
    { sourceAssets: [] },
    { sourceAssets: [makeSource('TRA_REFERENCE', 'a')] },
    {
      sourceAssets: [
        makeSource('TRA_VIDEO', 'a'),
        makeSource('LAYOUT_REFERENCE', 'b'),
      ],
    },
  ])('rejects selected frames without exactly one TRA video source %#', ({ sourceAssets }) => {
    expect(
      validateGenerateCreativeRequest({
        ...baseRequest,
        sourceAssets,
        videoFrameSelection,
      })
    ).toEqual({
      success: false,
      error: 'videoFrameSelection requires exactly one TRA_VIDEO source asset',
    });
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
