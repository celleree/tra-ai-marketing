import { afterEach, describe, expect, it, vi } from 'vitest';
import { planCreativeBatch, requestCreativeBatch } from '@/lib/ai/creative-planner';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { parseCreativePortfolioJob } from '@/lib/creatives/portfolio-job-parser';
import { buildCreativeRenderBrief } from '@/lib/creatives/render-brief';
import { portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';
import { CREATIVE_STRATEGY_JSON_SCHEMA } from '@/lib/creatives/strategy';
import { conceptDetails } from '../fixtures/creative-concept-details';
import { referenceCandidate } from '../fixtures/reference-catalog';
import { portfolioAudit } from '../fixtures/portfolio-audit';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { snapshotCreativePortfolio } from '@/lib/creatives/portfolio-snapshot';
import type { PreparedCreativeGeneration } from '@/lib/creatives/prepare-generation';
import type { PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';
import { parsePlanningSourceAnalysis } from '@/lib/creatives/planning-source-parser';
import { auditCreativePortfolio } from '@/lib/ai/portfolio-auditor';
vi.mock('@/lib/ai/portfolio-auditor', () => ({ auditCreativePortfolio: vi.fn(async (concepts: unknown[]) => portfolioAudit(concepts.length)) }));

const analysis = {
  summary: 'Clear visual hierarchy', visibleText: [], visualStructure: 'Headline over image',
  hookOrAngle: 'Clarity', offerOrCta: 'Talk with TRA', styleNotes: 'Calm', preserve: ['hierarchy'],
  avoid: ['third-party identity'], unknowns: ['performance'], dominantCategory: 'customer-problems' as const,
};
const strategy = (subjectSource: 'non-human' | 'approved-tra-human' = 'non-human') => ({
  conceptDetails,
  category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Taxpayer with an IRS notice',
  painPoint: 'Unclear next steps', desiredOutcome: 'A clear path forward', emotion: 'Relief',
  hook: 'Turn uncertainty into a next step', cta: 'Talk with TRA', offer: null,
  soWhat: { surfaceMessage: 'Understand the notice', functionalConsequence: 'Know the next step', meaningfulOutcome: 'Move forward with confidence' },
  execution: { taxDocumentReference: 'none', subjectSource, composition: 'single-focus', imageTreatment: 'minimal-graphic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' },
  visualDirection: 'An organized notice leading toward one clear next step',
});
const imageCopyFor = (index: number) => ({
  headline: `Image headline ${index}`,
  ...(index === 1 ? { shortSupport: 'Short support', cta: 'Talk with TRA' } : {}),
});
const concept = (index: number, subjectSource: 'non-human' | 'approved-tra-human' = 'non-human') => ({
  index, format: index === 1 ? 'educational' : 'proof',
  adCopy: { primaryText: `META_PRIMARY_${index}`, headline: `Meta headline ${index}`, description: `META_DESCRIPTION_${index}` },
  imageCopy: {
    headline: `Image headline ${index}`,
    shortSupport: index === 1 ? 'Short support' : null,
    proofAttribution: null,
    cta: index === 1 ? 'Talk with TRA' : null,
    disclosure: null,
  },
  strategy: { ...strategy(subjectSource), soWhat: { ...strategy().soWhat, surfaceMessage: `Distinct message ${index}` },
    conceptDetails: { ...conceptDetails, proposition: `Different proposition ${index}` } }, selectionReason: `Distinct reason ${index}`,
});
const payload = (value: unknown) => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const okResponse = (value: unknown) => new Response(JSON.stringify(payload(value)), { status: 200 });

const sourceProjection = (): PlanningSourceAnalysisState => ({ version: 1, entries:
  (['TRA_VIDEO', 'TRA_REFERENCE', 'LAYOUT_REFERENCE', 'TRA_VIDEO', 'TRA_REFERENCE', 'LAYOUT_REFERENCE'] as const).flatMap((role, i) => {
    const hex = String(i + 1), source = { role, mediaId: `media_${hex.repeat(32)}`, sha256: hex.repeat(64) };
    const observation = { ...analysis, summary: `SENTINEL_${role}_${hex}`, hookOrAngle: `ANGLE_${hex}` };
    const result = role === 'TRA_VIDEO'
      ? { kind: 'REPRESENTATIVE_VIDEO_FRAMES' as const, analysis: observation, analyzedFrames: [{ timestampMs: i * 1000, frameSha256: hex.repeat(64) }] }
      : role === 'TRA_REFERENCE' ? { kind: 'TRA_REFERENCE' as const, analysis: observation }
        : { kind: 'LAYOUT_ANGLE' as const, angleDescription: `SENTINEL_${role}_${hex}` };
    const results = role === 'TRA_VIDEO' ? [result] : [result, { kind: 'LAYOUT_BLUEPRINT' as const,
      layout: { blueprint: referenceCandidate().blueprint, contentHash: source.sha256, analyzerModel: 'analysis-model', cacheHit: true } }];
    return results.map(result => ({ source, analyzer: { kind: result.kind, model: 'analysis-model', schemaVersion: 1 as const,
      contextSha256: result.kind === 'LAYOUT_BLUEPRINT' ? null : 'a'.repeat(64) }, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const, result }));
  }) });

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.mocked(auditCreativePortfolio).mockClear(); });

describe('creative batch planner', () => {
  it('sends every source-labelled sentinel to Astra and retains initial/audit/repair arguments and snapshots on save/reload', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => okResponse({ creatives: [concept(1), concept(2)] }));
    vi.stubGlobal('fetch', fetchMock);
    const sourceAnalysis = sourceProjection(), storage = new MemoryPortfolioStorage();
    const requestedSources = [...new Map(sourceAnalysis.entries.map(e => [e.source.mediaId, e.source])).values()];
    const job = await createCreativePortfolio({ ...portfolioRequest(), sourceAssets: requestedSources.map(({ role, mediaId }) => ({ role, mediaId })) }, storage);
    const partial = structuredClone(sourceAnalysis); delete partial.entries[1].result;
    const initial = await updateCreativePortfolio(job.id, current => ({ ...current,
      planning: { phase: 'INITIAL_PLAN', preparation: { quotaReserved: true, analysis, sourceAnalysis: partial } } }), storage);
    expect(await readCreativePortfolio(job.id, storage)).toEqual(initial);
    const oversized = structuredClone(sourceAnalysis);
    const result = oversized.entries[0].result!;
    if (result.kind === 'REPRESENTATIVE_VIDEO_FRAMES') result.analysis.summary = 'x'.repeat(2 * 1024 * 1024);
    const before = [...storage.data.values()][0].bytes;
    await expect(updateCreativePortfolio(initial.id, () => ({ ...initial,
      planning: { phase: 'INITIAL_PLAN', preparation: { quotaReserved: true, sourceAnalysis: oversized } } }), storage)).rejects.toThrow();
    expect([...storage.data.values()][0].bytes).toEqual(before);
    expect(() => parseCreativePortfolioJob(Buffer.from(JSON.stringify({ ...initial,
      planning: { phase: 'INITIAL_PLAN', preparation: { quotaReserved: true, sourceAnalysis: oversized } } })), job.id)).toThrow('Saved creative portfolio is invalid');
    const plannerArgs = { count: 2, context: job.request.context, analysis, hasApprovedHumanSource: false, sourceAnalysis };
    const batchPlan = await requestCreativeBatch(plannerArgs);
    const snapshot = snapshotCreativePortfolio({ ...portfolioSnapshot(job), batchPlan, requestedSources, sourceAnalysis } as unknown as PreparedCreativeGeneration);
    const saved = await updateCreativePortfolio(job.id, current => ({ ...current,
      planning: { phase: 'DIVERSITY_AUDIT', repairAttempted: false, checkpoint: { plannerArgs, snapshot } } }), storage);
    const loaded = (await readCreativePortfolio(job.id, storage))!;
    expect(loaded).toEqual(saved);
    if (loaded.planning.phase !== 'DIVERSITY_AUDIT') throw new Error('Missing audit checkpoint');
    const mismatched = structuredClone(loaded);
    if (mismatched.planning.phase === 'DIVERSITY_AUDIT') delete mismatched.planning.checkpoint.plannerArgs.sourceAnalysis;
    expect(() => parseCreativePortfolioJob(Buffer.from(JSON.stringify(mismatched)), job.id)).toThrow('Saved creative portfolio is invalid');
    expect(loaded.planning.checkpoint.plannerArgs).toEqual(plannerArgs);
    expect(loaded.planning.checkpoint.snapshot.sourceAnalysis).toEqual(sourceAnalysis);
    const repeated = { ...portfolioAudit(2), groups: [{ conceptIndexes: [1, 2], proposition: 'Same', distinction: 'Repeated' }] };
    const repair = await updateCreativePortfolio(job.id, current => ({ ...current, planning: { phase: 'TARGETED_REPAIR',
      checkpoint: { plannerArgs, snapshot: { ...snapshot, batchPlan: { ...batchPlan, portfolioAudit: repeated } } } } }), storage);
    expect(await readCreativePortfolio(job.id, storage)).toEqual(repair);
    await requestCreativeBatch({ ...loaded.planning.checkpoint.plannerArgs, context: `${plannerArgs.context}\nRepair feedback` });
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://api.openai.com/v1/responses');
      const body = JSON.parse(String(init?.body)), input = JSON.parse(body.input[1].content[0].text);
      expect(body.model).toBe('gpt-6-astra');
      expect(input.sourceAnalysis).toEqual(sourceAnalysis);
      for (let i = 1; i <= 6; i++) expect(JSON.stringify(input.sourceAnalysis)).toContain(`SENTINEL_${requestedSources[i - 1].role}_${i}`);
      expect(input.sourceAnalysisGuidance).toContain('not full Video Intelligence');
      expect(input.sourceAnalysisGuidance).toContain('bucket counts disclose omitted observations');
      expect(input.sourceAnalysisGuidance).toContain('do not claim semantic or campaign relevance');
      expect(input.hasApprovedHumanSource).toBe(false);
    }
    const ready = await updateCreativePortfolio(job.id, current => ({ ...current, planning: { phase: 'READY_TO_RENDER' },
      snapshot: { ...snapshot, batchPlan: { ...batchPlan, portfolioAudit: portfolioAudit(2) } } }), storage);
    expect(await readCreativePortfolio(job.id, storage)).toEqual(ready);
  });

  it.each(['missing', 'duplicate', 'role', 'hash', 'model', 'version', 'result', 'frames', 'raw-bytes'])(
    'rejects invalid projection %s without dropping sources or making a provider call', async mutation => {
      const projection = sourceProjection(), expected = structuredClone([...new Map(projection.entries.map(e => [e.source.mediaId, e.source])).values()]);
      const entry = projection.entries[1];
      if (mutation === 'missing') projection.entries.splice(1, 2);
      if (mutation === 'duplicate') projection.entries.push(structuredClone(entry));
      if (mutation === 'role') entry.source.role = 'LAYOUT_REFERENCE';
      if (mutation === 'hash') entry.source.sha256 = 'f'.repeat(64);
      if (mutation === 'model') projection.entries[2].analyzer.model = 'changed';
      if (mutation === 'version') Object.assign(projection, { version: 2 });
      if (mutation === 'result') delete entry.result;
      if (mutation === 'frames') Object.assign(projection.entries[0].result!, { analyzedFrames: [] });
      if (mutation === 'raw-bytes') Object.assign(entry.result!, { buffer: { type: 'Buffer', data: [1] } });
      expect(() => parsePlanningSourceAnalysis(projection, expected, true)).toThrow();
      const job = newCreativePortfolio({ ...portfolioRequest(), sourceAssets: expected.map(({ role, mediaId }) => ({ role, mediaId })) });
      job.planning = { phase: 'READY_TO_RENDER' };
      job.snapshot = { ...portfolioSnapshot(job), requestedSources: expected, sourceAnalysis: projection };
      expect(() => parseCreativePortfolioJob(Buffer.from(JSON.stringify(job)), job.id)).toThrow('Saved creative portfolio is invalid');
      const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
      if (mutation !== 'missing' && mutation !== 'hash') await expect(requestCreativeBatch({ count: 2, context: 'TRA', analysis,
        hasApprovedHumanSource: false, sourceAnalysis: projection })).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

  it('keeps the developer prefix stable and sends compact decision inputs without mutating provenance', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => okResponse({ creatives: [concept(1), concept(2)] }));
    vi.stubGlobal('fetch', fetchMock);
    const args = { count: 2, context: 'Approved company context', analysis, hasApprovedHumanSource: false };
    await requestCreativeBatch(args);
    const referenceCatalog = [referenceCandidate('a')];
    const before = structuredClone(referenceCatalog);
    const id = `human_${'a'.repeat(64)}`;
    fetchMock.mockResolvedValueOnce(okResponse({ creatives: [1, 2, 3].map(index => ({ ...concept(index), approvedHumanId: null,
      referenceChoices: { angleSource: null, layoutSource: null } })) }));
    await requestCreativeBatch({ ...args, count: 3, referenceCatalog,
      approvedHumanOptions: [{ id, sourceName: 'TRA', description: 'Approved frame' }] });
    const [first, second] = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(first.input[0]).toEqual(second.input[0]);
    const inputText = second.input[1].content[0].text;
    const input = JSON.parse(inputText);
    expect(inputText).toBe(JSON.stringify(input));
    expect(input).toMatchObject({ creativeContext: args.context, referenceAnalysis: analysis });
    expect(input.referenceCatalog).toEqual(before.map(({ referenceId, priority, angleDescription, blueprint }) =>
      ({ referenceId, priority, angleDescription, blueprint })));
    expect(referenceCatalog).toEqual(before);
    expect(inputText.length).toBeLessThan(JSON.stringify({ ...input, referenceCatalog: before }, null, 2).length);
    const properties = second.text.format.schema.properties.creatives.items.properties;
    expect(Object.keys(properties).indexOf('strategy')).toBeLessThan(Object.keys(properties).indexOf('approvedHumanId'));
    expect(properties).not.toHaveProperty('copy');
    expect(properties.adCopy.required).toEqual(['primaryText', 'headline', 'description']);
    expect(properties.imageCopy.required).toEqual(['headline', 'shortSupport', 'proofAttribution', 'cta', 'disclosure']);
    expect(properties.referenceChoices.properties.layoutSource.anyOf[0].enum).toEqual([before[0].referenceId]);
    expect(properties.strategy).toEqual(CREATIVE_STRATEGY_JSON_SCHEMA);
    const rules = first.input[0].content[0].text;
    for (const rule of ['SO WHAT', 'Never invent testimonials', 'Without either, every subjectSource must be non-human',
      'third-party identity, branding, exact copy, people, claims, or evidence', 'document structure only',
      'Approval covers visible identity only', 'required disclaimers', 'Strong ideas may share a category or layout',
      'one causal clause per SO WHAT step', 'retain all execution details', 'Write adCopy and imageCopy separately',
      'Never add supporting copy merely to fill space']) expect(rules).toContain(rule);
  });

  it('persists the real initial request result through the PR A checkpoint and retains the complete render/strategy contract', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const referenceCatalog = [referenceCandidate('a')], id = `human_${'a'.repeat(64)}`;
    const creatives = [1, 2].map(index => ({ ...concept(index, 'approved-tra-human'), approvedHumanId: id,
      referenceChoices: { angleSource: referenceCatalog[0].referenceId, layoutSource: referenceCatalog[0].referenceId } }));
    const fetchMock = vi.fn(async () => okResponse({ creatives }));
    vi.stubGlobal('fetch', fetchMock);
    const plannerArgs = { count: 2, context: 'Frozen approved company context', analysis, hasApprovedHumanSource: false,
      referenceCatalog, approvedHumanOptions: [{ id, sourceName: 'TRA', description: 'Approved frame' }] };
    const batchPlan = await requestCreativeBatch(plannerArgs);
    const job = newCreativePortfolio(portfolioRequest());
    job.planning = { phase: 'DIVERSITY_AUDIT', repairAttempted: false,
      checkpoint: { plannerArgs, snapshot: { ...portfolioSnapshot(job), referenceCatalog, batchPlan } } };
    const reloaded = parseCreativePortfolioJob(Buffer.from(JSON.stringify(job)), job.id);
    expect(reloaded).toEqual(job);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auditCreativePortfolio).not.toHaveBeenCalled();
    expect(batchPlan).toMatchObject({ plannerModel: 'gpt-6-astra', reasoningEffort: 'medium' });
    expect(batchPlan).not.toHaveProperty('portfolioAudit');
    batchPlan.creatives.forEach((planned, index) => {
      expect(planned).toMatchObject({ index: index + 1, format: creatives[index].format,
        copy: creatives[index].adCopy, adCopy: creatives[index].adCopy, imageCopy: imageCopyFor(index + 1),
        selectionReason: creatives[index].selectionReason,
        strategy: { ...creatives[index].strategy, approvedHumanId: id,
          referenceSelection: { ...creatives[index].referenceChoices, referenceRelationship: 'matched' } } });
      expect(planned.copy).toEqual(planned.adCopy);
      const brief = buildCreativeRenderBrief({ concept: planned, referenceCatalog });
      expect(brief).toMatchObject({ exactCopy: imageCopyFor(index + 1),
        execution: planned.strategy.execution, visualDirection: planned.strategy.visualDirection,
        layoutBlueprint: referenceCatalog[0].blueprint, visualConcept: {
          visualArchetype: conceptDetails.visualArchetype, visualMechanism: conceptDetails.visualMechanism,
          subject: conceptDetails.subject, environment: conceptDetails.environment,
          compositionInstructions: conceptDetails.compositionInstructions } });
      expect(JSON.stringify(brief)).not.toContain(creatives[index].adCopy.primaryText);
      expect(JSON.stringify(brief)).not.toContain(creatives[index].adCopy.description);
    });
  });

  it('parses sparse and complete optional image-copy fields without inventing omitted text', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const first = { ...concept(1), imageCopy: { headline: 'Only image headline', shortSupport: null, proofAttribution: null, cta: null, disclosure: null } };
    const second = { ...concept(2), imageCopy: { headline: 'Full image headline', shortSupport: 'Support', proofAttribution: 'Approved attribution', cta: 'Learn more', disclosure: 'Applicable disclosure' } };
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ creatives: [first, second] })));
    const result = await requestCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false });
    expect(result.creatives[0].imageCopy).toEqual({ headline: 'Only image headline' });
    expect(result.creatives[1].imageCopy).toEqual(second.imageCopy);
  });

  it('selects a known library human independently per concept without a fixed ratio', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const id = `human_${'a'.repeat(64)}`;
    const approvedHumanOptions = [{ id, sourceName: 'TRA video', description: 'Approved presenter with room for copy' }];
    let creatives = [{ ...concept(1, 'approved-tra-human'), approvedHumanId: id }, { ...concept(2), approvedHumanId: null }];
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => okResponse({ creatives }));
    vi.stubGlobal('fetch', fetchMock);
    const args = { count: 2, context: '', analysis, hasApprovedHumanSource: false, approvedHumanOptions };
    const result = await planCreativeBatch(args);
    expect(result.creatives[0].strategy.approvedHumanId).toBe(id);
    expect(result.creatives[1].strategy).not.toHaveProperty('approvedHumanId');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(JSON.parse(body.input[1].content[0].text).approvedHumanOptions).toEqual(approvedHumanOptions);
    const approvedHumanIdSchema = body.text.format.schema.properties.creatives.items.properties.approvedHumanId;
    expect(approvedHumanIdSchema).toMatchObject({ type: ['string', 'null'] });
    expect(approvedHumanIdSchema).not.toHaveProperty('enum');
    expect(body.input[0].content[0].text).toContain('face availability alone is insufficient');
    creatives = [{ ...concept(1, 'approved-tra-human'), approvedHumanId: null }, { ...concept(2), approvedHumanId: null }];
    await expect(planCreativeBatch(args)).rejects.toThrow('invalid');
    creatives[0].approvedHumanId = `human_${'b'.repeat(64)}`;
    await expect(planCreativeBatch(args)).rejects.toThrow('invalid');
    creatives = [{ ...concept(1), approvedHumanId: id }, { ...concept(2), approvedHumanId: null }];
    await expect(planCreativeBatch(args)).rejects.toThrow('invalid');
  });
  it('bounds human options and keeps explicit supplied-source planning compatible', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn(async () => okResponse({ creatives: [
      { ...concept(1, 'approved-tra-human'), approvedHumanId: null }, { ...concept(2), approvedHumanId: null },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const args = { count: 2, context: '', analysis, hasApprovedHumanSource: true, approvedHumanOptions: [] };
    expect((await planCreativeBatch(args)).creatives[0].strategy).not.toHaveProperty('approvedHumanId');
    const option = { id: `human_${'a'.repeat(64)}`, sourceName: 'TRA video', description: 'Presenter' };
    await expect(planCreativeBatch({ ...args, approvedHumanOptions: Array(9).fill(option) })).rejects.toThrow('bounded');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('repairs a repeated semantic group once before returning the audited portfolio', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const repeated = { ...portfolioAudit(), groups: [{ conceptIndexes: [1, 2], proposition: 'Conversation leads to next steps', distinction: 'Paraphrases of the same idea' }] };
    vi.mocked(auditCreativePortfolio).mockResolvedValueOnce(repeated);
    const fetchMock = vi.fn(async () => okResponse({ creatives: [concept(1), concept(2)] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.portfolioAudit?.groups).toHaveLength(2);
    vi.mocked(auditCreativePortfolio).mockResolvedValueOnce(repeated).mockResolvedValueOnce(repeated);
    await expect(planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false })).rejects.toThrow('after one planning repair');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it('lets Astra choose all independent combinations and resolves known IDs deterministically', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const referenceCatalog = [referenceCandidate('a'), referenceCandidate('b')];
    const [a, b] = referenceCatalog.map(item => item.referenceId);
    const choices = [[a, a], [a, b], [a, null], [null, b], [null, null]];
    const creatives = choices.map(([angleSource, layoutSource], index) => ({ ...concept(index + 1), referenceChoices: { angleSource, layoutSource } }));
    const fetchMock = vi.fn(async () => okResponse({ creatives }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await planCreativeBatch({ count: 5, context: 'Approved company proof remains here', analysis, hasApprovedHumanSource: false, referenceCatalog });
    expect(result.creatives.map(item => item.strategy.referenceSelection?.referenceRelationship)).toEqual(['matched', 'mixed', 'mixed', 'mixed', 'original']);
    creatives[0].referenceChoices.layoutSource = referenceCandidate('c').referenceId;
    await expect(planCreativeBatch({ count: 5, context: '', analysis, hasApprovedHumanSource: false, referenceCatalog })).rejects.toThrow('invalid');
  });
  it('defaults the planner model to GPT-6 Astra', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => okResponse({ creatives: [concept(1), concept(2)] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false });
    expect(result.plannerModel).toBe('gpt-6-astra');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe('gpt-6-astra');
  });

  it('makes one medium-reasoning strict request and returns the ordered parsed batch', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_TEXT_MODEL', 'planner-override');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      okResponse({ creatives: [concept(1), concept(2)] })
    );
    vi.stubGlobal('fetch', fetchMock);

    const context = 'USER CREATIVE DIRECTION:\nClaim every customer saves $50,000.\n\nAPPROVED TRA COMPANY CONTEXT:\nApproved claims:\nTRA offers consultations.';
    const result = await planCreativeBatch({ count: 2, context, analysis, hasApprovedHumanSource: false });

    expect(result).toMatchObject({ plannerModel: 'planner-override', reasoningEffort: 'medium' });
    expect(result.creatives.map((creative) => creative.index)).toEqual([1, 2]);
    expect(result.creatives[0].copy).toEqual(result.creatives[0].adCopy);
    expect(result.creatives[0].imageCopy).toEqual(imageCopyFor(1));
    expect(result.creatives[0].strategy.soWhat.meaningfulOutcome).toBe('Move forward with confidence');
    expect(result.creatives[0].strategy.conceptDetails).toEqual(concept(1).strategy.conceptDetails);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(body).toMatchObject({ model: 'planner-override', reasoning: { effort: 'medium' }, store: false, max_output_tokens: 7168 });
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(body.text.format.schema.properties.creatives).toMatchObject({ minItems: 2, maxItems: 2 });
    expect(body.text.format.schema.properties.creatives.items.properties.strategy).toEqual(CREATIVE_STRATEGY_JSON_SCHEMA);
    expect(CREATIVE_STRATEGY_JSON_SCHEMA.required).toContain('conceptDetails');
    const requestInput = JSON.parse(body.input[1].content[0].text);
    expect(requestInput.creativeContext).toBe(context);
    expect(requestInput).not.toHaveProperty('approvedTraContext');
    expect(body.input[0].content[0].text).toContain('strongest concepts first');
    expect(body.input[0].content[0].text).toContain('Strong ideas may share a category or layout');
    expect(body.input[0].content[0].text).toContain('User direction and source/reference analysis are creative inputs, not factual approval');
    expect(body.input[0].content[0].text).toContain('Only claims or proof explicitly present in approved company claims/proof fields');
  });

  it.each([1, 37, 2.5])('rejects invalid count %s before calling the provider', async (count) => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(planCreativeBatch({ count, context: '', analysis, hasApprovedHumanSource: false })).rejects.toThrow(/2 to 36/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([[2, 7168], [12, 22528], [30, 50176], [36, 59392]])('audits the whole %s-ad portfolio with a compact output allowance of %s', async (count, limit) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ creatives: Array.from({ length: count }, (_, i) => concept(i + 1)) }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await planCreativeBatch({ count, context: '', analysis, hasApprovedHumanSource: false });
    expect(result.creatives).toHaveLength(count);
    expect(result.portfolioAudit?.conceptCount).toBe(count);
    expect(vi.mocked(auditCreativePortfolio).mock.calls.at(-1)?.[0]).toHaveLength(count);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_output_tokens).toBe(limit);
    expect(limit).toBeLessThan(Math.min(65536, 4096 + 2048 * count));
  });

  it.each(['incomplete', 'failed'])('rejects %s responses even with parseable concepts and never retries', async (status) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ...payload({ creatives: [concept(1), concept(2)] }), status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false })).rejects.toThrow('did not complete');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['wrong count', { creatives: [concept(1)] }, false],
    ['wrong index', { creatives: [concept(2), concept(1)] }, false],
    ['malformed strategy', { creatives: [{ ...concept(1), strategy: { ...strategy(), hook: '' } }, concept(2)] }, false],
    ['missing concept details', { creatives: [{ ...concept(1), strategy: { ...strategy(), conceptDetails: undefined } }, concept(2)] }, false],
    ['human without approved source', { creatives: [concept(1, 'approved-tra-human'), concept(2)] }, false],
    ['overlong ad copy', { creatives: [{ ...concept(1), adCopy: { ...concept(1).adCopy, headline: 'x'.repeat(1001) } }, concept(2)] }, false],
    ['missing image copy', { creatives: [{ ...concept(1), imageCopy: undefined }, concept(2)] }, false],
    ['malformed image copy', { creatives: [{ ...concept(1), imageCopy: { ...concept(1).imageCopy, shortSupport: 42 } }, concept(2)] }, false],
  ])('rejects %s output', async (_name, value, hasApprovedHumanSource) => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key'); vi.stubGlobal('fetch', vi.fn(async () => okResponse(value)));
    await expect(planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource })).rejects.toThrow(/invalid creative batch plan/i);
  });

  it('surfaces provider refusal and non-OK errors', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'Cannot comply' }] }] }), { status: 200 })));
    await expect(planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false })).rejects.toThrow(/refused.*Cannot comply/i);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Provider unavailable' } }), { status: 503 })));
    await expect(planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false })).rejects.toThrow('Provider unavailable');
  });

  it('rejects missing and malformed output', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output: [] }), { status: 200 })));
    await expect(planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false })).rejects.toThrow(/no creative batch plan/i);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{' }] }] }), { status: 200 })));
    await expect(planCreativeBatch({ count: 2, context: '', analysis, hasApprovedHumanSource: false })).rejects.toThrow(/malformed/i);
  });
});