import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { CreativeRecord } from '@/lib/creatives/generated';
import { buildCreativeCompanyContext, formatCreativeCompanyContext, normalizeRuntimeCompanyProfile } from '@/lib/company/creative-context';
import { buildSavedCopilotContext } from '@/lib/copilot/context';
import { parseCopilotContextSnapshot, parseCopilotSavedCreativeEvidence } from '@/lib/copilot/records';
import { requestClaudeCopilot } from '@/lib/copilot/claude';

const mocks = vi.hoisted(() => ({ listCreatives: vi.fn() }));
vi.mock('@/lib/creatives/storage', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/creatives/storage')>(), listCreatives: mocks.listCreatives }));
const id = `creative_${'a'.repeat(32)}`;
const saved = (): CreativeRecord => ({ id, createdAt: '2026-10-11T12:00:00Z', category: 'customer-problems',
  image: { id: `media_${'b'.repeat(32)}`, fileName: `media_${'b'.repeat(32)}.png`, originalName: 'saved.png', mimeType: 'image/png', size: 10, url: '/private.png' },
  copy: { primaryText: 'Saved primary text', headline: 'Saved headline', description: '' },
  identity: { conceptId: id, parentCreativeId: null, operation: 'GENERATE', fingerprint: 'c'.repeat(64) },
  referenceImageId: `media_${'d'.repeat(32)}` });
const profile = { knowledgeBase: { companySummary: 'Explicitly approved company summary' }, guardrails: { neverSay: 'Never promise outcomes' } };
beforeEach(() => mocks.listCreatives.mockReset().mockResolvedValue([saved()]));

describe('server-built saved creative Copilot context', () => {
  it('loads saved authority and hashes the normalized effective company context', async () => {
    const result = await buildSavedCopilotContext(id, profile, true);
    const approvedText = formatCreativeCompanyContext(buildCreativeCompanyContext(normalizeRuntimeCompanyProfile(profile)));
    expect(mocks.listCreatives).toHaveBeenCalledTimes(1);
    expect(result.company).toEqual({ approvedText, reference: `company:sha256:${createHash('sha256').update(approvedText).digest('hex')}` });
    expect(result.creatives[0]).toEqual({ creativeId: id, identity: saved().identity, sourceReferences: [], evidence: {
      adCopy: saved().copy, imageCopy: null, category: 'customer-problems', format: null, placement: null, strategy: null, humanReviewStatus: null } });
    expect(result.performance).toBe('unknown'); expect(approvedText).toContain('[UNKNOWN / NOT APPROVED]');
  });
  it.each([false, undefined, 'true'])('requires explicit approval before loading creative: %s', async approval => {
    await expect(buildSavedCopilotContext(id, profile, approval)).rejects.toMatchObject({ code: 'approval_required' });
    expect(mocks.listCreatives).not.toHaveBeenCalled();
  });
  it('rejects invalid inputs before storage and missing/identity-less saved records', async () => {
    await expect(buildSavedCopilotContext('../creative', profile, true)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(buildSavedCopilotContext(id, 'profile', true)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(mocks.listCreatives).not.toHaveBeenCalled();
    mocks.listCreatives.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...saved(), identity: undefined }]);
    await expect(buildSavedCopilotContext(id, profile, true)).rejects.toMatchObject({ code: 'creative_unavailable' });
    await expect(buildSavedCopilotContext(id, profile, true)).rejects.toMatchObject({ code: 'creative_unavailable' });
  });
  it('keeps ad/image copy separate and copies the saved compact plan without inventing legacy details', async () => {
    const creative = saved();
    creative.adCopy = { ...creative.copy, headline: 'Ad headline' }; creative.copy = { ...creative.adCopy }; creative.imageCopy = { headline: 'Image headline', cta: 'Read more' };
    creative.format = 'direct-response'; creative.placement = 'SQUARE_1_1'; creative.humanReview = { status: 'PENDING' };
    const soWhat = { surfaceMessage: 'Understand next step', functionalConsequence: 'Learn consultation process', meaningfulOutcome: 'Proceed with confidence' };
    creative.planning = { model: 'gpt-6.1-sol', reasoningEffort: 'medium', selectionReason: 'Saved selection', strategy: {
      category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'TRA customer', painPoint: 'Unclear next step',
      desiredOutcome: 'Clarity', emotion: 'Hope', hook: 'Saved hook', cta: 'Learn more', offer: null, soWhat,
      visualDirection: 'Saved planned visual', execution: { subjectSource: 'non-human', composition: 'single-focus',
        imageTreatment: 'illustrative', textDensity: 'low', ctaTreatment: 'inline', typographyHierarchy: 'headline-dominant' } } };
    mocks.listCreatives.mockResolvedValue([creative]);
    const result = await buildSavedCopilotContext(id, profile, true); const evidence = result.creatives[0].evidence!;
    expect(evidence).toMatchObject({ adCopy: creative.adCopy, imageCopy: creative.imageCopy, format: 'direct-response', placement: 'SQUARE_1_1',
      humanReviewStatus: 'PENDING', strategy: { hook: 'Saved hook', proposition: null, visualDirection: 'Saved planned visual', soWhat } });
    creative.adCopy.headline = 'changed'; creative.imageCopy.headline = 'changed'; soWhat.surfaceMessage = 'changed';
    expect(evidence.adCopy.headline).toBe('Ad headline'); expect(evidence.imageCopy?.headline).toBe('Image headline');
    expect(evidence.strategy?.soWhat.surfaceMessage).toBe('Understand next step');
  });
  it('preserves old contexts and rejects oversized/invalid evidence instead of truncating saved copy', async () => {
    const context = await buildSavedCopilotContext(id, profile, true); const creative = context.creatives[0];
    const { evidence, ...legacy } = creative;
    expect(parseCopilotContextSnapshot({ ...context, creatives: [legacy] })?.creatives[0]).not.toHaveProperty('evidence');
    expect(parseCopilotContextSnapshot({ ...context, creatives: [{ ...legacy, evidence: null }] })?.creatives[0].evidence).toBeNull();
    for (const invalid of [{ ...evidence, category: 'invalid' }, { ...evidence, format: 'invalid' }, { ...evidence, placement: 'invalid' }, { ...evidence, humanReviewStatus: 'auto-approved' },
      { ...evidence, adCopy: { ...evidence!.adCopy, headline: 'x'.repeat(1001) } }, { ...evidence, imageCopy: { headline: 'x'.repeat(1001) } },
      { ...evidence, strategy: { hook: 'Hook', proposition: null, visualDirection: '', soWhat: {} } }]) {
      expect(parseCopilotSavedCreativeEvidence(invalid)).toBeNull();
      expect(parseCopilotContextSnapshot({ ...context, creatives: [{ ...creative, evidence: invalid }] })).toBeNull();
    }
    mocks.listCreatives.mockResolvedValue([{ ...saved(), copy: { ...saved().copy, primaryText: 'x'.repeat(1001) } }]);
    await expect(buildSavedCopilotContext(id, profile, true)).rejects.toMatchObject({ code: 'invalid_evidence' });
  });
  it('passes the complete server-built snapshot unchanged to the offline provider wire', async () => {
    const context = await buildSavedCopilotContext(id, profile, true);
    const output = { version: 1, generatedAt: '2026-10-11T12:00:00Z', action: 'DO_NOTHING', observations: [], inferences: [], recommendation: null, unknowns: ['Performance unknown'], performance: 'unknown' };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }] })));
    const result = await requestClaudeCopilot(context, { apiKey: 'offline-key', allowPaidRequest: true, maxOutputTokens: 1024, fetch: fetchMock });
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(JSON.parse(body.messages[0].content)).toEqual(context); expect(result.context).toEqual(context);
    expect(body.system).toContain('NOT approved factual proof'); expect(body.system).toContain('No image pixels are supplied');
  });
});
