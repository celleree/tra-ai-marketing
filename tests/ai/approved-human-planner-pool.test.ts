import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestCreativeBatch } from '@/lib/ai/creative-planner';
import { conceptDetails } from '../fixtures/creative-concept-details';

const analysis = {
  summary: 'Clear visual hierarchy', visibleText: [], visualStructure: 'Headline over image',
  hookOrAngle: 'Clarity', offerOrCta: 'Talk with TRA', styleNotes: 'Calm', preserve: ['hierarchy'],
  avoid: ['third-party identity'], unknowns: ['performance'], dominantCategory: 'customer-problems' as const,
};
const strategy = (subjectSource: 'non-human' | 'approved-tra-human') => ({
  conceptDetails,
  category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Taxpayer with an IRS notice',
  painPoint: 'Unclear next steps', desiredOutcome: 'A clear path forward', emotion: 'Relief',
  hook: 'Turn uncertainty into a next step', cta: 'Talk with TRA', offer: null,
  soWhat: { surfaceMessage: 'Understand the notice', functionalConsequence: 'Know the next step', meaningfulOutcome: 'Move forward with confidence' },
  execution: { taxDocumentReference: 'none', subjectSource, composition: 'single-focus', imageTreatment: 'minimal-graphic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' },
  visualDirection: 'An organized notice leading toward one clear next step',
});
const concept = (index: number, approvedHumanId: string | null) => ({
  index,
  format: 'direct-response',
  adCopy: { primaryText: `Meta primary ${index}`, headline: `Meta headline ${index}`, description: '' },
  imageCopy: { headline: `Image headline ${index}`, shortSupport: null, proofAttribution: null, cta: null, disclosure: null },
  strategy: strategy(approvedHumanId ? 'approved-tra-human' : 'non-human'),
  selectionReason: `Distinct reason ${index}`,
  approvedHumanId,
});
const payload = (value: unknown) => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const okResponse = (value: unknown) => new Response(JSON.stringify(payload(value)), { status: 200 });
const options = Array.from({ length: 10 }, (_, index) => ({
  id: `human_${(index + 1).toString(16).padStart(64, '0')}`,
  sourceName: `TRA source ${index + 1}`,
  description: `Approved presenter ${index + 1}`,
}));

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('approved-human planner pool', () => {
  it('sends more than eight validated approved-human options to Astra and accepts the last option', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn(async () => okResponse({ creatives: [concept(1, options[9].id), concept(2, null)] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestCreativeBatch({
      count: 2, context: 'Approved context', analysis, hasApprovedHumanSource: false, approvedHumanOptions: options,
    });

    expect(result.creatives[0].strategy.approvedHumanId).toBe(options[9].id);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const input = JSON.parse(body.input[1].content[0].text);
    expect(input.approvedHumanOptions).toEqual(options);
    expect(body.text.format.schema.properties.creatives.items.properties.approvedHumanId.enum)
      .toEqual([null, ...options.map(option => option.id)]);
  });

  it.each([
    ['duplicate IDs', [options[0], { ...options[1], id: options[0].id }]],
    ['malformed ID', [{ ...options[0], id: 'human_bad' }]],
  ])('rejects %s before provider work', async (_name, approvedHumanOptions) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(requestCreativeBatch({
      count: 2, context: '', analysis, hasApprovedHumanSource: false, approvedHumanOptions,
    })).rejects.toThrow('Invalid approved-human options');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an Astra human ID that was not offered', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const unknown = `human_${'f'.repeat(64)}`;
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ creatives: [concept(1, unknown), concept(2, null)] })));
    await expect(requestCreativeBatch({
      count: 2, context: '', analysis, hasApprovedHumanSource: false, approvedHumanOptions: options,
    })).rejects.toThrow('invalid creative batch plan concept');
  });
});
