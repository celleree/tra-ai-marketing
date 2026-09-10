import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCreativeRevisionImage } from '@/lib/ai/creative-revision-image';
import type { EligibleProviderImageSource } from '@/lib/media/source-hydration';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';

type Args = Parameters<typeof generateCreativeRevisionImage>[0];
const fetchMock = vi.fn();
const args = (): Args => ({
  operation: 'EDIT', placement: 'PORTRAIT_4_5', companyContext: 'Approved claims: consultation available. Required disclaimer: results vary.', instruction: 'Move the CTA down.',
  concept: { format: 'direct-response', copy: { headline: 'Get clarity', primaryText: 'Find your next step', description: '' },
    strategy: { category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Taxpayer', painPoint: 'Unclear next steps', desiredOutcome: 'Clarity', emotion: 'Relief', hook: 'Get clarity', cta: 'Consult us', offer: null,
      soWhat: { surfaceMessage: 'Organize your case', functionalConsequence: 'Understand your options', meaningfulOutcome: 'Move forward confidently' },
      execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'photographic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' }, visualDirection: 'A clean desk' } },
  sources: { canvas: { kind: 'EDITING_CANVAS', approvedHumanSource: false, mediaId: 'canvas', fileName: 'canvas.png', mimeType: 'image/png', buffer: Buffer.from('canvas'), sha256: 'a'.repeat(64) }, originalApprovedSource: null, logoOverlay: null },
});
const body = () => fetchMock.mock.calls[0][1].body as FormData;
const files = () => body().getAll('image[]') as File[];
const response = () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('provider-output').toString('base64') }] }));
beforeEach(() => { vi.stubEnv('OPENAI_API_KEY', 'fixture-only'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset().mockImplementation(async () => response()); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('revision image provider', () => {
  it('sends the editing canvas first with exact placement and returns actual prompt/model', async () => {
    const result = await generateCreativeRevisionImage(args());
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/images/edits');
    expect(body().get('size')).toBe('1024x1280');
    expect(body().get('quality')).toBe('high');
    expect(body().get('output_format')).toBe('png');
    expect(files()).toHaveLength(1);
    expect(files()[0].name).toBe('editing-canvas-canvas.png');
    expect(Buffer.from(await files()[0].arrayBuffer()).toString()).toBe('canvas');
    expect(result).toMatchObject({ buffer: Buffer.from('provider-output'), prompt: body().get('prompt'), model: 'gpt-image-2.5-sunburst', routing: { operationType: 'EDIT', preferredModel: 'gpt-image-2.5-sunburst', actualModel: 'gpt-image-2.5-sunburst', fallbackUsed: false } });
    expect(result.prompt).toContain('never an approved human-identity source');
    expect(result.prompt).toContain('There are no approved human source attachments');
    expect(result.prompt).toContain('results vary');
    expect(result.prompt).toContain('Move the CTA down.');
  });
  it('attaches the original reference separately and leaves original logo for server compositing', async () => {
    const input = args();
    input.sources.originalApprovedSource = { kind: 'TRA_REFERENCE', sha256: 'b'.repeat(64), source: { stored: { buffer: Buffer.from('original'), mimeType: 'image/png', fileName: 'original.png' } } as EligibleProviderImageSource };
    input.sources.logoOverlay = { kind: 'LOGO_OVERLAY', mediaId: 'logo', fileName: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('logo'), sha256: 'c'.repeat(64) };
    await generateCreativeRevisionImage(input);
    expect(files().map(file => file.name)).toEqual(['editing-canvas-canvas.png', 'approved-tra-source-original.png']);
    expect(Buffer.from(await files()[1].arrayBuffer()).toString()).toBe('original');
    expect(body().get('prompt')).toContain('Do not depict people even if original approved sources contain people');
    expect(body().get('prompt')).toContain('original approved logo will be composited');
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
