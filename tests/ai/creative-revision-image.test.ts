import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCreativeRevisionImage } from '@/lib/ai/creative-revision-image';
import type { EligibleProviderImageSource } from '@/lib/media/source-hydration';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';
import { referenceCandidate } from '../fixtures/reference-catalog';
import { resolveReferenceSelection } from '@/lib/references/planning';
import { resolveCreativeLogoGeometry } from '@/lib/creatives/logo-placement';

type Args = Parameters<typeof generateCreativeRevisionImage>[0];
const fetchMock = vi.fn();
const args = (): Args => ({
  operation: 'EDIT', placement: 'PORTRAIT_4_5',
  companyProfile: { knowledgeBase: { companySummary: 'PRIVATE_COMPANY_SUMMARY' }, guardrails: { requiredDisclaimers: 'results vary.' } },
  concept: { format: 'direct-response', copy: { headline: 'Get clarity', primaryText: 'Find your next step', description: '' },
    strategy: { category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Taxpayer', painPoint: 'Unclear next steps', desiredOutcome: 'Clarity', emotion: 'Relief', hook: 'Get clarity', cta: 'Consult us', offer: null,
      soWhat: { surfaceMessage: 'Organize your case', functionalConsequence: 'Understand your options', meaningfulOutcome: 'Move forward confidently' },
      execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'photographic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' }, visualDirection: 'A clean desk with the CTA moved down.' } },
  sources: { canvas: { kind: 'EDITING_CANVAS', approvedHumanSource: false, mediaId: 'canvas', fileName: 'canvas.png', mimeType: 'image/png', buffer: Buffer.from('canvas'), sha256: 'a'.repeat(64) }, originalApprovedSource: null, logoOverlay: null },
});
const body = () => fetchMock.mock.calls[0][1].body as FormData;
const files = () => body().getAll('image[]') as File[];
const response = () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('provider-output').toString('base64') }] }));
beforeEach(() => { vi.stubEnv('OPENAI_API_KEY', 'fixture-only'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset().mockImplementation(async () => response()); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('revision image provider', () => {
  it.each(['EDIT', 'PLACEMENT', 'REGENERATE', 'VARIATION'] as const)('uses the saved selected blueprint for %s without attaching reference pixels', async operation => {
    const input = args();
    input.operation = operation;
    input.referenceCatalog = [referenceCandidate('a'), referenceCandidate('b')];
    input.referenceCatalog[1].blueprint.ctaTreatment = 'OUTLINE';
    input.concept.strategy.referenceSelection = resolveReferenceSelection({ angleSource: input.referenceCatalog[0].referenceId,
      layoutSource: input.referenceCatalog[1].referenceId }, input.referenceCatalog);
    const result = await generateCreativeRevisionImage(input);
    expect(result.prompt).toContain('"ctaTreatment": "OUTLINE"');
    expect(result.prompt).not.toContain('"ctaTreatment": "PILL"');
    expect(result.prompt).not.toContain(input.referenceCatalog[0].angleDescription);
    expect(files().map(file => file.name)).toEqual(['editing-canvas-canvas.png']);
  });
  it.each(['none', 'irs-mail-v1'] as const)('keeps the editing canvas first with document selection %s', async taxDocumentReference => {
    const input = args();
    input.concept.strategy.execution.taxDocumentReference = taxDocumentReference;
    const result = await generateCreativeRevisionImage(input);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/images/edits');
    expect(body().get('size')).toBe('1024x1280');
    expect(body().get('quality')).toBe('high');
    expect(body().get('output_format')).toBe('png');
    expect(files()).toHaveLength(taxDocumentReference === 'none' ? 1 : 2);
    if (taxDocumentReference !== 'none') {
      expect(files()[1].name).toBe('tax-document-irs-mail-v1.jpg');
      expect(result.prompt).toContain('Leave sensitive fields blank');
    } else expect(result.prompt).not.toContain('DOCUMENT-ONLY REFERENCE');
    expect(files()[0].name).toBe('editing-canvas-canvas.png');
    expect(Buffer.from(await files()[0].arrayBuffer()).toString()).toBe('canvas');
    expect(result).toMatchObject({ buffer: Buffer.from('provider-output'), prompt: body().get('prompt'), model: 'gpt-image-2.5-sunburst', routing: { operationType: 'EDIT', preferredModel: 'gpt-image-2.5-sunburst', actualModel: 'gpt-image-2.5-sunburst', fallbackUsed: false } });
    expect(result.prompt).toContain('never an approved human-identity source');
    expect(result.prompt).toContain('There are no approved human source attachments');
    expect(result.prompt).toContain('results vary');
    expect(result.prompt).toContain('CTA moved down');
    expect(result.prompt).not.toContain('PRIVATE_COMPANY_SUMMARY');
    expect(result.prompt).not.toContain('Current approved company context');
  });
  it.each(['EDIT', 'PLACEMENT', 'REGENERATE', 'VARIATION'] as const)('sends only imageCopy to the actual %s provider prompt for E2 revisions', async operation => {
    const input = args();
    const adCopy = {
      primaryText: 'META_PRIMARY_SENTINEL_NEVER_IMAGE',
      headline: 'META_HEADLINE_SENTINEL_NEVER_IMAGE',
      description: 'META_DESCRIPTION_SENTINEL_NEVER_IMAGE',
    };
    input.operation = operation;
    input.concept = { ...input.concept, copy: adCopy, adCopy,
      imageCopy: { headline: 'IMAGE_HEADLINE_SENTINEL', shortSupport: 'IMAGE_SUPPORT_SENTINEL', cta: 'IMAGE_CTA_SENTINEL' } };
    await generateCreativeRevisionImage(input);
    const prompt = body().get('prompt') as string;
    expect(prompt).toContain('IMAGE_HEADLINE_SENTINEL');
    expect(prompt).toContain('IMAGE_SUPPORT_SENTINEL');
    expect(prompt).toContain('IMAGE_CTA_SENTINEL');
    expect(prompt).not.toContain('META_PRIMARY_SENTINEL_NEVER_IMAGE');
    expect(prompt).not.toContain('META_HEADLINE_SENTINEL_NEVER_IMAGE');
    expect(prompt).not.toContain('META_DESCRIPTION_SENTINEL_NEVER_IMAGE');
  });
  it.each(['EDIT', 'VARIATION', 'REGENERATE', 'PLACEMENT'] as const)('carries authoritative Proof into the %s revision render contract', async operation => {
    const input = args();
    input.operation = operation;
    input.proofProvenance = {
      version: 1, type: 'case-study', proofId: `proof_${'7'.repeat(32)}`,
      proofUpdatedAt: '2026-09-18T14:00:00.000Z',
      selectedText: 'Approved source-bound claim wording.',
      usageRestrictions: 'Use only for bank-levy messaging.',
      requiredDisclaimer: 'Results vary by circumstances.',
    };
    const adCopy = {
      primaryText: `Normal copy.\n\n${input.proofProvenance.selectedText}\n\n${input.proofProvenance.requiredDisclaimer}`,
      headline: 'Meta headline',
      description: '',
    };
    input.concept = { ...input.concept, copy: adCopy, adCopy,
      imageCopy: { headline: 'Image headline', disclosure: input.proofProvenance.requiredDisclaimer } };

    const result = await generateCreativeRevisionImage(input);

    expect(result.prompt).toContain(input.proofProvenance.proofId);
    expect(result.prompt).toContain(input.proofProvenance.proofUpdatedAt);
    expect(result.prompt).toContain(input.proofProvenance.selectedText);
    expect(result.prompt).toContain(input.proofProvenance.usageRestrictions);
    expect(result.prompt).toContain(input.proofProvenance.requiredDisclaimer);
    expect(result.prompt).toContain('It is NOT additional image copy');
    expect(result.prompt).toContain(`"disclosure": "${input.proofProvenance.requiredDisclaimer}"`);
  });

  it('rejects invalid separated copy before image-provider work', async () => {
    const cases = [
      { adCopy: { primaryText: 'Meta only', headline: 'Meta only', description: '' } },
      { imageCopy: { headline: 'Image only' } },
      { adCopy: { primaryText: 'Mismatch', headline: 'Mismatch', description: '' }, imageCopy: { headline: 'Image copy' } },
    ];
    for (const separated of cases) {
      fetchMock.mockClear();
      const input = args();
      input.concept = { ...input.concept, ...separated } as Args['concept'];
      await expect(generateCreativeRevisionImage(input)).rejects.toThrow('invalid separated ad/image copy contract');
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });
  it('attaches the original reference separately and leaves original logo for server compositing', async () => {
    const input = args();
    input.sources.originalApprovedSource = { kind: 'TRA_REFERENCE', sha256: 'b'.repeat(64), source: { stored: { buffer: Buffer.from('original'), mimeType: 'image/png', fileName: 'original.png' } } as EligibleProviderImageSource };
    input.sources.logoOverlay = { kind: 'LOGO_OVERLAY', mediaId: 'logo', fileName: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('logo'), sha256: 'c'.repeat(64) };
    input.logoGeometry = resolveCreativeLogoGeometry('PORTRAIT_4_5', 'top-center', 200, 100);
    await generateCreativeRevisionImage(input);
    expect(files().map(file => file.name)).toEqual(['editing-canvas-canvas.png', 'approved-tra-source-original.png']);
    expect(Buffer.from(await files()[1].arrayBuffer()).toString()).toBe('original');
    expect(body().get('prompt')).toContain('Do not depict people even if original approved sources contain people');
    expect(body().get('prompt')).toContain('original approved logo and its complete backing panel');
    expect(body().get('prompt')).toContain('deterministically removed prior logo panel');
    expect(body().get('prompt')).toContain('invisible composition constraint');
    expect(body().get('prompt')).toContain('do not render a placeholder, box, panel, border, dashed outline');
  });
  it('retains the exact approved video frame subset and order', async () => {
    const input = args();
    input.concept.strategy.execution.subjectSource = 'approved-tra-human';
    input.sources.originalApprovedSource = { kind: 'TRA_VIDEO_FRAMES', source: {} as never, selectionMode: 'USER_SELECTED', frames: ['last', 'first'].map(value => ({ buffer: Buffer.from(value), mimeType: 'image/png' } as ApprovedTraVideoFrame)) };
    await generateCreativeRevisionImage(input);
    expect(await Promise.all(files().map(async file => Buffer.from(await file.arrayBuffer()).toString()))).toEqual(['canvas', 'last', 'first']);
    expect(body().get('prompt')).toContain('Only these attachments may supply human identity');
  });
  it.each(['EDIT', 'PLACEMENT', 'REGENERATE', 'VARIATION'] as const)('expresses %s intent and always prefers Sunburst', async operation => {
    await generateCreativeRevisionImage({ ...args(), operation, placement: 'VERTICAL_9_16' });
    expect(body().get('prompt')).toContain(`Operation: ${operation}.`);
    expect(body().get('size')).toBe('1152x2048');
    expect(body().get('prompt')).toContain('x=70..1081, y=287..1330');
    expect(body().get('model')).toBe('gpt-image-2.5-sunburst');
  });
  it('rejects human strategy without original approval before spending', async () => {
    const input = args(); input.concept.strategy.execution.subjectSource = 'approved-tra-human';
    await expect(generateCreativeRevisionImage(input)).rejects.toThrow('unavailable approved TRA source');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('fails clearly for absent credentials, provider errors and missing output', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    await expect(generateCreativeRevisionImage(args())).rejects.toThrow('not configured');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv('OPENAI_API_KEY', 'fixture-only');
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await expect(generateCreativeRevisionImage(args())).rejects.toThrow('503');
    fetchMock.mockResolvedValueOnce(new Response('{"data":[]}'));
    fetchMock.mockResolvedValueOnce(new Response('{"data":[]}'));
    await expect(generateCreativeRevisionImage(args())).rejects.toThrow('no generated image');
  });

  it('retries one transient failure with Flare and reports the fallback', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    fetchMock.mockResolvedValueOnce(response());
    const result = await generateCreativeRevisionImage(args());
    const models = fetchMock.mock.calls.map((call) => (call[1].body as FormData).get('model'));
    expect(models).toEqual(['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']);
    expect(result.routing).toMatchObject({ fallbackUsed: true, fallbackFromModel: 'gpt-image-2.5-sunburst', fallbackReason: 'provider_unavailable', actualModel: 'gpt-image-2.5-flare' });
  });

  it('does not retry deterministic provider rejection', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 400 }));
    await expect(generateCreativeRevisionImage(args())).rejects.toThrow('400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
