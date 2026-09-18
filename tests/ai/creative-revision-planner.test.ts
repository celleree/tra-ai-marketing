import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planCreativeRevision } from '@/lib/ai/creative-revision-planner';
import type { CreativeStrategy } from '@/lib/creatives/strategy';
import { approvedHumanSourceId } from '@/lib/video/approved-human';
import { conceptDetails } from '../fixtures/creative-concept-details';
import { referenceCandidate } from '../fixtures/reference-catalog';

const strategy: CreativeStrategy = {
  category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Busy taxpayer', painPoint: 'Unclear next steps', desiredOutcome: 'A clear plan', emotion: 'Relief', hook: 'Find a path forward', cta: 'Get a consultation', offer: null,
  soWhat: { surfaceMessage: 'Understand the next step', functionalConsequence: 'Organize your options', meaningfulOutcome: 'Move forward with confidence' },
  execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'minimal-graphic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' }, visualDirection: 'A clean desk',
};
const parent = { format: 'direct-response' as const, copy: { headline: 'Find a path forward', primaryText: 'Talk with TRA', description: '' }, strategy };
const plan = () => ({ ...parent, strategy: { ...strategy, conceptDetails }, selectionReason: 'Respect the requested edit.' });
const payload = (value: unknown) => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const fetchMock = vi.fn();
const args = { parent, operation: 'EDIT' as const, instruction: 'Make the headline blue.', companyContext: 'APPROVED TRA COMPANY CONTEXT\nNo numeric claims approved.', hasApprovedHumanSource: false };

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'fixture-key');
  vi.stubEnv('OPENAI_TEXT_MODEL', '');
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify(payload(plan()))));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('single-creative revision planning', () => {
  it('preserves a curated identity for human revisions and drops the choice for a graphic edit', async () => {
    const approvedHumanId = `human_${'a'.repeat(64)}`;
    const humanStrategy = { ...strategy, approvedHumanId, execution: { ...strategy.execution, subjectSource: 'approved-tra-human' as const } };
    const humanArgs = { ...args, parent: { ...parent, strategy: humanStrategy }, hasApprovedHumanSource: true };
    const humanOutput = { ...plan(), strategy: { ...strategy, conceptDetails, execution: humanStrategy.execution } };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload(humanOutput))));
    expect((await planCreativeRevision(humanArgs)).concept.strategy.approvedHumanId).toBe(approvedHumanId);
    expect((await planCreativeRevision(humanArgs)).concept.strategy).not.toHaveProperty('approvedHumanId');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload({ ...humanOutput, strategy: { ...humanOutput.strategy, approvedHumanId } }))));
    await expect(planCreativeRevision(humanArgs)).rejects.toThrow('cannot replace');
  });
  it('preserves a generalized identity for human revisions and drops it for a non-human edit', async () => {
    const approvedHumanId = `human_${'b'.repeat(64)}`;
    const humanSourceId = approvedHumanSourceId(approvedHumanId);
    const humanStrategy = { ...strategy, humanSourceId, execution: { ...strategy.execution, subjectSource: 'approved-tra-human' as const } };
    const humanArgs = { ...args, parent: { ...parent, strategy: humanStrategy }, hasApprovedHumanSource: true };
    const humanOutput = { ...plan(), strategy: { ...strategy, conceptDetails, execution: humanStrategy.execution } };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload(humanOutput))));
    const preserved = await planCreativeRevision(humanArgs);
    expect(preserved.concept.strategy.humanSourceId).toBe(humanSourceId);
    expect(preserved.concept.strategy).not.toHaveProperty('approvedHumanId');
    expect((await planCreativeRevision(humanArgs)).concept.strategy).not.toHaveProperty('humanSourceId');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload({ ...humanOutput, strategy: { ...humanOutput.strategy, humanSourceId } }))));
    await expect(planCreativeRevision(humanArgs)).rejects.toThrow('cannot replace');
  });
  it('preserves a generalized identity through a meaningful human VARIATION', async () => {
    const approvedHumanId = `human_${'c'.repeat(64)}`;
    const humanSourceId = approvedHumanSourceId(approvedHumanId);
    const humanStrategy = { ...strategy, humanSourceId, execution: { ...strategy.execution, subjectSource: 'approved-tra-human' as const } };
    const variationArgs = { ...args, parent: { ...parent, strategy: humanStrategy }, hasApprovedHumanSource: true, operation: 'VARIATION' as const };
    const changedStrategy = { ...strategy, conceptDetails, awarenessStage: 'solution-aware' as const,
      soWhat: { ...strategy.soWhat, surfaceMessage: 'Compare a clearer path' },
      execution: { ...humanStrategy.execution, composition: 'split' as const, imageTreatment: 'illustrative' as const } };
    const output = { ...plan(), copy: { ...parent.copy, headline: 'Move beyond the notices' },
      strategy: changedStrategy, selectionReason: 'Meaningfully different human execution.' };

    expect(output.strategy).not.toHaveProperty('humanSourceId');
    expect(output.strategy).not.toHaveProperty('approvedHumanId');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload(output))));
    const result = await planCreativeRevision(variationArgs);

    expect(result.concept.strategy.awarenessStage).toBe('solution-aware');
    expect(result.concept.strategy.humanSourceId).toBe(humanSourceId);
    expect(result.concept.strategy).not.toHaveProperty('approvedHumanId');
  });

  it('resolves independent revision choices and rejects missing catalog IDs', async () => {
    const referenceCatalog = [referenceCandidate()];
    const referenceChoices = { angleSource: referenceCatalog[0].referenceId, layoutSource: null };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload({ ...plan(), referenceChoices }))));
    expect((await planCreativeRevision({ ...args, referenceCatalog })).concept.strategy.referenceSelection)
      .toEqual({ ...referenceChoices, referenceRelationship: 'mixed' });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload({ ...plan(), referenceChoices }))));
    await expect(planCreativeRevision({ ...args, referenceCatalog: [] })).rejects.toThrow('Unavailable');
  });
  it('uses one Astra Medium request and permits an ordinary edit without variation requirements', async () => {
    const result = await planCreativeRevision(args);
    expect(result).toMatchObject({ concept: { ...plan(), index: 1 }, plannerModel: 'gpt-6-astra', reasoningEffort: 'medium' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body.store).toBe(false);
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.properties.strategy.properties).not.toHaveProperty('approvedHumanId');
    expect(body.text.format.schema.properties.strategy.properties).not.toHaveProperty('humanSourceId');
    expect(JSON.parse(body.input[1].content[0].text)).toEqual(args);
    expect(body.input[0].content[0].text).toContain('not evidence that its claims are approved');
    expect(body.input[0].content[0].text).toContain('canvas and layout/reference-library content never confer human approval');
  });

  it('keeps E2 EDIT copy separated and makes copy the adCopy alias', async () => {
    const adCopy = { primaryText: 'META_PRIMARY_SENTINEL', headline: 'Meta headline', description: 'META_DESCRIPTION_SENTINEL' };
    const e2Parent = { ...parent, copy: adCopy, adCopy, imageCopy: { headline: 'Image headline', cta: 'Image CTA' } };
    const revisedAdCopy = { ...adCopy, headline: 'Revised Meta headline' };
    const output = { format: parent.format, adCopy: revisedAdCopy,
      imageCopy: { headline: 'Revised image headline', shortSupport: null, proofAttribution: null, cta: 'Start here', disclosure: null },
      strategy: { ...strategy, conceptDetails }, selectionReason: 'Edit the requested surfaces only.' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload(output))));
    const result = await planCreativeRevision({ ...args, parent: e2Parent });
    expect(result.concept.copy).toEqual(revisedAdCopy);
    expect(result.concept.adCopy).toEqual(revisedAdCopy);
    expect(result.concept.imageCopy).toEqual({ headline: 'Revised image headline', cta: 'Start here' });
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.text.format.schema.required).toContain('imageCopy');
    expect(request.input[0].content[0].text).toContain('Never move Meta primaryText or Meta description into imageCopy');
  });

  it('supplies inherited Proof provenance to Astra as an immutable revision constraint', async () => {
    const selectedText = 'Exact inherited review excerpt.';
    const adCopy = { primaryText: selectedText, headline: 'Meta headline', description: '' };
    const e2Parent = { ...parent, copy: adCopy, adCopy,
      imageCopy: { headline: 'Image headline', proofAttribution: 'Verified TRA client' } };
    const proofProvenance = {
      version: 1 as const, type: 'review' as const, proofId: `proof_${'9'.repeat(32)}`,
      proofUpdatedAt: '2026-09-18T13:00:00.000Z', selectedText, attribution: 'Verified TRA client',
    };
    const output = { format: parent.format, adCopy,
      imageCopy: { headline: 'Image headline', shortSupport: null, proofAttribution: 'Verified TRA client', cta: null, disclosure: null },
      strategy: { ...strategy, conceptDetails }, selectionReason: 'Keep inherited Proof intact.' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload(output))));

    await planCreativeRevision({ ...args, parent: e2Parent, proofProvenance });

    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(JSON.parse(request.input[1].content[0].text).proofProvenance).toEqual(proofProvenance);
    expect(request.input[0].content[0].text).toContain('immutable, already revalidated Proof constraint');
    expect(request.input[0].content[0].text).toContain('must remain verbatim');
    expect(request.input[0].content[0].text).toContain('D3 does not allow selecting, replacing');
  });

  it('keeps E2 VARIATION purpose-specific instead of collapsing copy surfaces', async () => {
    const adCopy = { primaryText: 'META_PRIMARY_SENTINEL', headline: 'Meta headline', description: 'META_DESCRIPTION_SENTINEL' };
    const e2Parent = { ...parent, copy: adCopy, adCopy, imageCopy: { headline: 'Image headline' } };
    const changedStrategy = { ...strategy, conceptDetails, awarenessStage: 'solution-aware' as const,
      soWhat: { ...strategy.soWhat, surfaceMessage: 'Compare a clearer path' },
      execution: { ...strategy.execution, composition: 'split' as const, imageTreatment: 'illustrative' as const } };
    const output = { format: parent.format,
      adCopy: { primaryText: 'Different Meta body', headline: 'Different Meta headline', description: 'Different Meta description' },
      imageCopy: { headline: 'Sparse image headline', shortSupport: null, proofAttribution: null, cta: null, disclosure: null },
      strategy: changedStrategy, selectionReason: 'Meaningfully different execution.' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload(output))));
    const result = await planCreativeRevision({ ...args, parent: e2Parent, operation: 'VARIATION' });
    expect(result.concept.copy).toEqual(result.concept.adCopy);
    expect(result.concept.imageCopy).toEqual({ headline: 'Sparse image headline' });
    expect(result.concept.imageCopy).not.toHaveProperty('primaryText');
    expect(result.concept.strategy.awarenessStage).toBe('solution-aware');
  });

  it('retains configured planner model identity', async () => {
    vi.stubEnv('OPENAI_TEXT_MODEL', 'configured-planner');
    expect((await planCreativeRevision(args)).plannerModel).toBe('configured-planner');
  });

  it('rejects superficial variations and accepts meaningful strategic/execution differences', async () => {
    await expect(planCreativeRevision({ ...args, operation: 'VARIATION' })).rejects.toThrow('too similar');
    const changed = { ...plan(), copy: { ...parent.copy, headline: 'Move beyond the notices' }, strategy: { ...strategy, conceptDetails, awarenessStage: 'solution-aware', soWhat: { ...strategy.soWhat, surfaceMessage: 'Explore a resolution path' }, execution: { ...strategy.execution, composition: 'split', imageTreatment: 'illustrative' } } };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload(changed))));
    expect((await planCreativeRevision({ ...args, operation: 'VARIATION' })).concept.strategy.awarenessStage).toBe('solution-aware');
  });

  it.each([
    { ...plan(), strategy },
    { ...plan(), extra: true },
    { ...plan(), copy: { ...parent.copy, headline: 'x'.repeat(1001) } },
    { ...plan(), strategy: { ...strategy, execution: { ...strategy.execution, subjectSource: 'approved-tra-human' } } },
    { ...plan(), strategy: { ...strategy, soWhat: null } },
  ])('rejects malformed plans or unavailable human sources %#', async (value) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload(value))));
    await expect(planCreativeRevision(args)).rejects.toThrow('invalid revision');
  });

  it('surfaces provider failures, missing output and refusals without inventing a plan', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    await expect(planCreativeRevision(args)).rejects.toThrow('HTTP 429');
    fetchMock.mockResolvedValueOnce(new Response('{}'));
    await expect(planCreativeRevision(args)).rejects.toThrow('no revision plan');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ output: [{ content: [{ type: 'refusal', refusal: 'Unavailable' }] }] })));
    await expect(planCreativeRevision(args)).rejects.toThrow('declined');
  });
});
