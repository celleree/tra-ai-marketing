import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/creatives/[creativeId]/revise/route';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import { CreativeRevisionHydrationError } from '@/lib/creatives/revision-source-hydration';
import { GeneratedImageValidationError } from '@/lib/creatives/generated-image-validation';
import { ProofRevalidationError } from '@/lib/proof/provenance';
import { approvedHumanSourceId } from '@/lib/video/approved-human';
import type { CreativeRecord } from '@/lib/creatives/generated';
import type { CreativeStrategy } from '@/lib/creatives/strategy';

const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), hydrate: vi.fn(), plan: vi.fn(), generate: vi.fn(), validate: vi.fn(), logo: vi.fn(), saveImage: vi.fn(), getOperatorAccess: vi.fn(), requireOperatorQuota: vi.fn(), human: vi.fn(), proof: vi.fn() }));
vi.mock('@/lib/video/approved-human-service', () => ({ requireActiveHumanSelection: mocks.human }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.getOperatorAccess }));
vi.mock('@/lib/quotas/require-quota', () => ({ requireOperatorQuota: mocks.requireOperatorQuota }));
vi.mock('@/lib/creatives/storage', async importOriginal => ({ ...await importOriginal<object>(), listCreatives: mocks.list, saveCreativeBatch: mocks.save }));
vi.mock('@/lib/proof/provenance', async importOriginal => ({ ...await importOriginal<object>(), revalidateCreativeProofProvenanceForPaidWork: mocks.proof }));
vi.mock('@/lib/creatives/revision-source-hydration', async importOriginal => ({ ...await importOriginal<object>(), hydrateSavedCreativeRevisionContext: mocks.hydrate }));
vi.mock('@/lib/creatives/generated-image-validation', async importOriginal => ({ ...await importOriginal<object>(), validateGeneratedCreativeImage: mocks.validate }));
vi.mock('@/lib/ai/creative-revision-planner', () => ({ planCreativeRevision: mocks.plan }));
vi.mock('@/lib/ai/creative-revision-image', () => ({ generateCreativeRevisionImage: mocks.generate }));
vi.mock('@/lib/creatives/brand-logo.server', () => ({ compositeCreativeBrandLogo: mocks.logo }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: () => ({ saveImage: mocks.saveImage }) }));

const parentId = `creative_${'a'.repeat(32)}`;
const mediaId = `media_${'b'.repeat(32)}`;
const approvedHumanRecordId = `human_${'f'.repeat(64)}`;
const generalizedHumanSourceId = approvedHumanSourceId(approvedHumanRecordId);
const strategy: CreativeStrategy = {
  category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Taxpayer', painPoint: 'Unclear next steps', desiredOutcome: 'Clarity', emotion: 'Relief', hook: 'Get clarity', cta: 'Consult us', offer: null,
  soWhat: { surfaceMessage: 'Organize your case', functionalConsequence: 'Understand your options', meaningfulOutcome: 'Move forward confidently' },
  execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'photographic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' }, visualDirection: 'A clean desk',
};
const parent = (): CreativeRecord => ({
  id: parentId, createdAt: '2026-09-07T00:00:00.000Z', format: 'direct-response', placement: 'SQUARE_1_1', category: strategy.category,
  copy: { primaryText: 'Get help with your next step', headline: 'Find clarity', description: '' },
  image: { id: mediaId, fileName: `${mediaId}.png`, originalName: 'original.png', mimeType: 'image/png', size: 50, url: '' },
  identity: buildCreativeIdentity({ creativeId: parentId, operation: 'GENERATE', strategy }),
  planning: { strategy, selectionReason: 'Saved choice', model: 'saved-planner', reasoningEffort: 'medium' },
  generationProvenance: { version: 1, imageGeneration: { prompt: 'old prompt', model: 'old-image-model' }, requestedSources: [], attachedSource: null, analysisSources: [] },
});
const generalizedHumanParent = (): CreativeRecord => {
  const record = parent();
  const humanStrategy: CreativeStrategy = { ...strategy, humanSourceId: generalizedHumanSourceId,
    execution: { ...strategy.execution, subjectSource: 'approved-tra-human' } };
  record.planning = { ...record.planning!, strategy: humanStrategy };
  record.identity = buildCreativeIdentity({ creativeId: record.id, operation: 'GENERATE', strategy: humanStrategy });
  record.videoFrameSelection = { libraryId:`video-library:${'a'.repeat(64)}`, sourceVideoMediaId:mediaId, sourceVideoContentHash:'f'.repeat(64),
    frames:[{frameIndex:0,libraryFrameId:`video-frame:${'c'.repeat(64)}`,candidateFrameSha256:'d'.repeat(64),timestampMs:1000,approvedPngSha256:'e'.repeat(64)}] };
  record.generationProvenance = {
    ...record.generationProvenance!,
    requestedSources: [{ role: 'TRA_VIDEO', mediaId, sha256: 'f'.repeat(64) }],
    attachedSource: { type: 'TRA_VIDEO_FRAMES', mediaId, sourceSha256: 'f'.repeat(64), selectionMode: 'USER_SELECTED',
      frames: [{ timestampMs: 1000, approvedPngSha256: 'e'.repeat(64) }] },
  };
  return record;
};
const e2Parent = (): CreativeRecord => {
  const record = parent();
  const adCopy = { primaryText: 'META_PRIMARY_SENTINEL_NEVER_IMAGE', headline: 'Meta headline', description: 'META_DESCRIPTION_SENTINEL_NEVER_IMAGE' };
  return { ...record, copy: adCopy, adCopy, imageCopy: { headline: 'IMAGE_HEADLINE_SENTINEL', cta: 'IMAGE_CTA_SENTINEL' } };
};
const proofParent = (): CreativeRecord => {
  const record = e2Parent();
  const selectedText = 'The representative explained every step clearly.';
  const adCopy = { ...record.adCopy!, primaryText: selectedText };
  return {
    ...record, copy: adCopy, adCopy,
    imageCopy: { ...record.imageCopy!, proofAttribution: 'Verified TRA client' },
    proofProvenance: {
      version: 1,
      type: 'review',
      proofId: `proof_${'9'.repeat(32)}`,
      proofUpdatedAt: '2026-09-18T13:00:00.000Z',
      selectedText,
      attribution: 'Verified TRA client',
    },
  };
};
const caseStudyProofParent = (): CreativeRecord => {
  const record = e2Parent();
  const selectedText = 'Approved source-bound claim wording.';
  const adCopy = { ...record.adCopy!, primaryText: selectedText };
  return {
    ...record, copy: adCopy, adCopy,
    imageCopy: { ...record.imageCopy!, disclosure: 'Results vary by circumstances.' },
    proofProvenance: {
      version: 1,
      type: 'case-study',
      proofId: `proof_${'8'.repeat(32)}`,
      proofUpdatedAt: '2026-09-18T14:00:00.000Z',
      selectedText,
      usageRestrictions: 'Use only for bank-levy messaging.',
      requiredDisclaimer: 'Results vary by circumstances.',
    },
  };
};
const call = (body: unknown, creativeId = parentId) => POST(new Request('http://localhost/api/creatives/revise', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ creativeId }) });
const hydrate = (record: CreativeRecord) => ({ parent: { record, identity: record.identity, planning: record.planning, provenance: record.generationProvenance }, canvas: { kind: 'EDITING_CANVAS', approvedHumanSource: false, mediaId, sha256: 'c'.repeat(64) }, originalApprovedSource: null, logoOverlay: null });
const hydrateGeneralizedHuman = (record: CreativeRecord) => ({ ...hydrate(record), originalApprovedSource:{kind:'TRA_VIDEO_FRAMES',frames:[]} });
beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.getOperatorAccess.mockResolvedValue({ allowed: true, userId: 'operator' });
  mocks.requireOperatorQuota.mockResolvedValue(null);
  mocks.proof.mockImplementation(async proof => proof);
  const record = parent();
  mocks.list.mockResolvedValue([record]); mocks.hydrate.mockResolvedValue(hydrate(record));
  mocks.generate.mockImplementation(async ({ operation }) => ({
    buffer: Buffer.from('raw'), prompt: 'actual revision prompt', model: 'gpt-image-2.5-sunburst',
    routing: { operationType: operation, preferredModel: 'gpt-image-2.5-sunburst', actualModel: 'gpt-image-2.5-sunburst', fallbackUsed: false, fallbackFromModel: null, fallbackReason: null },
  }));
  mocks.validate.mockResolvedValue(undefined); mocks.logo.mockResolvedValue(Buffer.from('final branded'));
  mocks.saveImage.mockResolvedValue({ ...record.image, id: `media_${'d'.repeat(32)}`, fileName: `media_${'d'.repeat(32)}.png` });
  mocks.save.mockImplementation(async records => records);
  mocks.plan.mockResolvedValue({ concept: { index: 1, format: record.format, copy: { ...record.copy, headline: 'Edited headline' }, strategy, selectionReason: 'Requested edit' }, plannerModel: 'gpt-6-astra', reasoningEffort: 'medium' });
});

describe('saved creative revision API', () => {
  it('drops a removed library human and prevents later reuse after deactivation', async () => {
    const record = parent();
    record.planning!.strategy = { ...strategy, approvedHumanId: `human_${'a'.repeat(64)}`, execution: { ...strategy.execution, subjectSource: 'approved-tra-human' } };
    record.identity = buildCreativeIdentity({ creativeId: record.id, operation:'GENERATE', strategy: record.planning!.strategy });
    record.videoFrameSelection = { libraryId:`video-library:${'a'.repeat(64)}`, sourceVideoMediaId:mediaId, sourceVideoContentHash:'b'.repeat(64),
      frames:[{frameIndex:0,libraryFrameId:`video-frame:${'c'.repeat(64)}`,candidateFrameSha256:'d'.repeat(64),timestampMs:1000,approvedPngSha256:'e'.repeat(64)}] };
    mocks.list.mockResolvedValue([record]);
    mocks.hydrate.mockResolvedValue({ ...hydrate(record), originalApprovedSource:{kind:'TRA_VIDEO_FRAMES',frames:[]} });
    const response = await call({ operation:'EDIT', instruction:'Remove the person and make this a graphic ad.' });
    const { creative } = await response.json();
    expect(response.status).toBe(201);
    expect(mocks.generate.mock.calls[0][0].sources.originalApprovedSource).toBeNull();
    expect(creative.generationProvenance.attachedSource).toBeNull();
    expect(creative).not.toHaveProperty('videoFrameSelection');
    expect(creative.planning.strategy).not.toHaveProperty('approvedHumanId');
    mocks.generate.mockClear(); mocks.human.mockRejectedValue(new Error('Human deactivated after planning'));
    expect((await call({operation:'REGENERATE'})).status).toBe(409);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it.each(['EDIT', 'VARIATION'] as const)('preserves generalized approved-human identity and source through %s', async operation => {
    const record = generalizedHumanParent();
    const revisedStrategy: CreativeStrategy = { ...record.planning!.strategy,
      ...(operation === 'VARIATION' ? { awarenessStage: 'solution-aware' as const, execution: { ...record.planning!.strategy.execution, composition: 'split' as const } } : {}) };
    mocks.list.mockResolvedValue([record]); mocks.hydrate.mockResolvedValue(hydrateGeneralizedHuman(record));
    mocks.plan.mockResolvedValue({ concept: { index: 1, format: record.format, copy: record.copy, strategy: revisedStrategy, selectionReason: 'Keep the same approved person.' }, plannerModel: 'gpt-6-astra', reasoningEffort: 'medium' });
    const response = await call({ operation, instruction: 'Keep the same approved person while revising the creative.' });
    const { creative } = await response.json();
    expect(response.status).toBe(201);
    expect(creative.planning.strategy.humanSourceId).toBe(generalizedHumanSourceId);
    expect(creative.planning.strategy).not.toHaveProperty('approvedHumanId');
    expect(mocks.human).toHaveBeenCalledWith(approvedHumanRecordId, record.videoFrameSelection);
    expect(mocks.generate.mock.calls[0][0].sources.originalApprovedSource).not.toBeNull();
    expect(creative.generationProvenance.attachedSource).toEqual(record.generationProvenance!.attachedSource);
    expect(creative.videoFrameSelection).toEqual(record.videoFrameSelection);
  });
  it.each(['EDIT', 'VARIATION'] as const)('rejects revoked generalized approved-human identity after %s planning before provider work', async operation => {
    const record = generalizedHumanParent();
    const revisedStrategy: CreativeStrategy = { ...record.planning!.strategy,
      ...(operation === 'VARIATION' ? { awarenessStage: 'solution-aware' as const, execution: { ...record.planning!.strategy.execution, composition: 'split' as const } } : {}) };
    mocks.list.mockResolvedValue([record]); mocks.hydrate.mockResolvedValue(hydrateGeneralizedHuman(record));
    mocks.plan.mockResolvedValue({ concept: { index: 1, format: record.format, copy: record.copy, strategy: revisedStrategy, selectionReason: 'Keep the same approved person.' }, plannerModel: 'gpt-6-astra', reasoningEffort: 'medium' });
    mocks.human.mockRejectedValueOnce(new Error('Human deactivated after planning'));
    const response = await call({ operation, instruction: 'Keep the same approved person.' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Human deactivated after planning' });
    expect(mocks.human).toHaveBeenCalledWith(approvedHumanRecordId, record.videoFrameSelection);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.saveImage).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(['EDIT', 'VARIATION'] as const)('fully detaches generalized approved-human identity when %s becomes non-human', async operation => {
    const record = generalizedHumanParent();
    const nonHumanStrategy: CreativeStrategy = { ...strategy,
      ...(operation === 'VARIATION' ? { awarenessStage: 'solution-aware' as const, execution: { ...strategy.execution, composition: 'split' as const } } : {}) };
    mocks.list.mockResolvedValue([record]); mocks.hydrate.mockResolvedValue(hydrateGeneralizedHuman(record));
    mocks.plan.mockResolvedValue({ concept: { index: 1, format: record.format, copy: record.copy, strategy: nonHumanStrategy, selectionReason: 'Remove the person.' }, plannerModel: 'gpt-6-astra', reasoningEffort: 'medium' });
    const response = await call({ operation, instruction: 'Remove the person and make this non-human.' });
    const { creative } = await response.json();
    expect(response.status).toBe(201);
    expect(creative.planning.strategy).not.toHaveProperty('humanSourceId');
    expect(creative.planning.strategy).not.toHaveProperty('approvedHumanId');
    expect(mocks.generate.mock.calls[0][0].sources.originalApprovedSource).toBeNull();
    expect(creative.generationProvenance.attachedSource).toBeNull();
    expect(creative).not.toHaveProperty('videoFrameSelection');
  });
  it('fails closed on a malformed generalized human identity before provider work', async () => {
    const record = generalizedHumanParent();
    const malformedStrategy: CreativeStrategy = { ...record.planning!.strategy, humanSourceId: 'approved-human:invalid' };
    mocks.list.mockResolvedValue([record]); mocks.hydrate.mockResolvedValue(hydrateGeneralizedHuman(record));
    mocks.plan.mockResolvedValue({ concept: { index: 1, format: record.format, copy: record.copy, strategy: malformedStrategy, selectionReason: 'Malformed source.' }, plannerModel: 'gpt-6-astra', reasoningEffort: 'medium' });
    const response = await call({ operation: 'EDIT', instruction: 'Keep the same person.' });
    expect(response.status).toBe(409);
    expect(mocks.human).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(['REGENERATE', 'PLACEMENT'] as const)('creates a new saved legacy %s without inventing separated copy', async operation => {
    const original = parent();
    const result = await call({ operation, ...(operation === 'PLACEMENT' ? { placement: 'PORTRAIT_4_5' } : {}) });
    expect(result.status).toBe(201);
    const { creative } = await result.json();
    expect(creative.id).not.toBe(parentId);
    expect(creative.identity).toMatchObject({ operation, parentCreativeId: parentId, fingerprint: original.identity!.fingerprint, conceptId: operation === 'PLACEMENT' ? parentId : creative.id });
    expect(creative.copy).toEqual(original.copy);
    expect(creative).not.toHaveProperty('adCopy');
    expect(creative).not.toHaveProperty('imageCopy');
    expect(creative.placement).toBe(operation === 'PLACEMENT' ? 'PORTRAIT_4_5' : 'SQUARE_1_1');
    expect(creative.generationProvenance).toMatchObject({ imageGeneration: { prompt: 'actual revision prompt', model: 'gpt-image-2.5-sunburst', routing: { preferredModel: 'gpt-image-2.5-sunburst', actualModel: 'gpt-image-2.5-sunburst', fallbackUsed: false } }, revision: { parentCreativeId: parentId, canvasMediaId: mediaId, canvasSha256: 'c'.repeat(64) } });
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.save.mock.calls[0][0]).toHaveLength(1);
    await expect(mocks.list.mock.results[0].value).resolves.toEqual([original]);
  });
  it.each(['EDIT', 'VARIATION', 'REGENERATE', 'PLACEMENT'] as const)('revalidates and preserves Proof provenance through %s before provider work', async operation => {
    const original = proofParent();
    mocks.list.mockResolvedValue([original]);
    mocks.hydrate.mockResolvedValue(hydrate(original));
    if (operation === 'EDIT' || operation === 'VARIATION') {
      const changed = operation === 'VARIATION'
        ? { ...strategy, awarenessStage: 'solution-aware' as const, execution: { ...strategy.execution, composition: 'split' as const } }
        : strategy;
      mocks.plan.mockResolvedValue({
        concept: { index: 1, format: original.format, copy: original.copy, adCopy: original.adCopy, imageCopy: original.imageCopy, strategy: changed, selectionReason: 'Proof remains applicable.' },
        plannerModel: 'gpt-6-astra', reasoningEffort: 'medium',
      });
    }
    const response = await call({
      operation,
      ...((operation === 'EDIT' || operation === 'VARIATION') ? { instruction: 'Keep the approved proof while revising the execution.' } : {}),
      ...(operation === 'PLACEMENT' ? { placement: 'PORTRAIT_4_5' } : {}),
    });
    const { creative } = await response.json();

    expect(response.status).toBe(201);
    expect(mocks.proof).toHaveBeenCalledWith(original.proofProvenance);
    expect(mocks.proof.mock.invocationCallOrder[0]).toBeLessThan(mocks.generate.mock.invocationCallOrder[0]);
    if (operation === 'EDIT' || operation === 'VARIATION') {
      expect(mocks.proof.mock.invocationCallOrder[0]).toBeLessThan(mocks.plan.mock.invocationCallOrder[0]);
      expect(mocks.plan.mock.calls[0][0].proofProvenance).toEqual(original.proofProvenance);
    }
    expect(mocks.generate.mock.calls[0][0].proofProvenance).toEqual(original.proofProvenance);
    expect(creative.proofProvenance).toEqual(original.proofProvenance);
  });

  it.each(['EDIT', 'VARIATION'] as const)('rejects %s when inherited Review attribution is changed or removed', async operation => {
    const original = proofParent();
    mocks.list.mockResolvedValue([original]); mocks.hydrate.mockResolvedValue(hydrate(original));
    const changed = operation === 'VARIATION'
      ? { ...strategy, awarenessStage: 'solution-aware' as const, execution: { ...strategy.execution, composition: 'split' as const } }
      : strategy;
    mocks.plan.mockResolvedValue({ concept: {
      index: 1, format: original.format, copy: original.copy, adCopy: original.adCopy,
      imageCopy: { ...original.imageCopy!, proofAttribution: operation === 'EDIT' ? undefined : 'Changed attribution' },
      strategy: changed, selectionReason: 'Invalid proof edit.',
    }, plannerModel: 'gpt-6-astra', reasoningEffort: 'medium' });

    const response = await call({ operation, instruction: 'Change the proof presentation.' });

    expect(response.status).toBe(409);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.saveImage).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(['EDIT', 'VARIATION'] as const)('rejects %s when inherited selected Proof text is changed or removed', async operation => {
    const original = proofParent();
    mocks.list.mockResolvedValue([original]); mocks.hydrate.mockResolvedValue(hydrate(original));
    const changed = operation === 'VARIATION'
      ? { ...strategy, awarenessStage: 'solution-aware' as const, execution: { ...strategy.execution, composition: 'split' as const } }
      : strategy;
    const adCopy = { ...original.adCopy!, primaryText: operation === 'EDIT' ? 'Rewritten testimonial.' : 'Different claim.' };
    mocks.plan.mockResolvedValue({ concept: {
      index: 1, format: original.format, copy: adCopy, adCopy, imageCopy: original.imageCopy,
      strategy: changed, selectionReason: 'Invalid proof rewrite.',
    }, plannerModel: 'gpt-6-astra', reasoningEffort: 'medium' });

    const response = await call({ operation, instruction: 'Rewrite the proof.' });

    expect(response.status).toBe(409);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.saveImage).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(['EDIT', 'VARIATION'] as const)('rejects %s when inherited Case Study disclaimer is changed or removed', async operation => {
    const original = caseStudyProofParent();
    mocks.list.mockResolvedValue([original]); mocks.hydrate.mockResolvedValue(hydrate(original));
    const changed = operation === 'VARIATION'
      ? { ...strategy, awarenessStage: 'solution-aware' as const, execution: { ...strategy.execution, composition: 'split' as const } }
      : strategy;
    mocks.plan.mockResolvedValue({ concept: {
      index: 1, format: original.format, copy: original.copy, adCopy: original.adCopy,
      imageCopy: { ...original.imageCopy!, disclosure: operation === 'EDIT' ? undefined : 'Changed disclaimer.' },
      strategy: changed, selectionReason: 'Invalid disclaimer edit.',
    }, plannerModel: 'gpt-6-astra', reasoningEffort: 'medium' });

    const response = await call({ operation, instruction: 'Change the disclaimer.' });

    expect(response.status).toBe(409);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.saveImage).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('blocks a revoked historical Proof before revision planning, hydration, image provider, or saving', async () => {
    const original = proofParent();
    mocks.list.mockResolvedValue([original]);
    mocks.proof.mockRejectedValue(new ProofRevalidationError(
      'Selected Proof must be reselected before paid rendering or revision: advertising use is no longer approved.'
    ));

    const response = await call({ operation: 'EDIT', instruction: 'Refresh this creative.' });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Selected Proof must be reselected before paid rendering or revision: advertising use is no longer approved.',
    });
    expect(mocks.hydrate).not.toHaveBeenCalled();
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.saveImage).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(original.proofProvenance).toEqual(proofParent().proofProvenance);
  });

  it('does not fabricate or revalidate Proof provenance for legacy no-Proof revisions', async () => {
    const response = await call({ operation: 'REGENERATE' });
    const { creative } = await response.json();

    expect(response.status).toBe(201);
    expect(mocks.proof).not.toHaveBeenCalled();
    expect(creative).not.toHaveProperty('proofProvenance');
  });

  it.each(['REGENERATE', 'PLACEMENT'] as const)('preserves separated E2 copy through saved %s revisions', async operation => {
    const original = e2Parent();
    mocks.list.mockResolvedValue([original]); mocks.hydrate.mockResolvedValue(hydrate(original));
    const response = await call({ operation, ...(operation === 'PLACEMENT' ? { placement: 'PORTRAIT_4_5' } : {}) });
    const { creative } = await response.json();
    expect(response.status).toBe(201);
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.generate.mock.calls[0][0].concept).toMatchObject({ copy: original.adCopy, adCopy: original.adCopy, imageCopy: original.imageCopy });
    expect(creative.copy).toEqual(original.adCopy);
    expect(creative.adCopy).toEqual(original.adCopy);
    expect(creative.imageCopy).toEqual(original.imageCopy);
  });
  it.each(['EDIT', 'VARIATION'] as const)('plans legacy %s with current company context without inventing separated copy', async operation => {
    const changed = { ...strategy, awarenessStage: 'solution-aware' as const, execution: { ...strategy.execution, composition: 'split' as const, textDensity: 'medium' as const } };
    mocks.plan.mockResolvedValue({ concept: { index: 1, format: 'direct-response', copy: parent().copy, strategy: changed, selectionReason: 'Changed strategy' }, plannerModel: 'gpt-6-astra', reasoningEffort: 'medium' });
    const response = await call({ operation, instruction: 'Use a different composition.' });
    const { creative } = await response.json();
    expect(response.status).toBe(201);
    expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({ operation, hasApprovedHumanSource: false, instruction: 'Use a different composition.', companyContext: expect.stringContaining('APPROVED TRA COMPANY CONTEXT') }));
    expect(mocks.generate.mock.calls[0][0]).not.toHaveProperty('companyContext');
    expect(mocks.generate.mock.calls[0][0]).not.toHaveProperty('instruction');
    expect(mocks.generate.mock.calls[0][0].concept.strategy).toEqual(changed);
    expect(creative).not.toHaveProperty('adCopy');
    expect(creative).not.toHaveProperty('imageCopy');
    expect(creative.planning.strategy).toEqual(changed);
    expect(creative.identity.fingerprint).not.toBe(parent().identity!.fingerprint);
    expect(creative.identity.conceptId).toBe(operation === 'EDIT' ? parentId : creative.id);
    expect(creative.generationProvenance.revision.instruction).toBe('Use a different composition.');
  });
  it.each(['EDIT', 'VARIATION'] as const)('preserves separated E2 copy through planned %s revisions', async operation => {
    const original = e2Parent();
    const changed = { ...strategy, awarenessStage: 'solution-aware' as const, execution: { ...strategy.execution, composition: 'split' as const, textDensity: 'medium' as const } };
    const adCopy = { primaryText: 'Revised Meta body', headline: 'Revised Meta headline', description: 'Revised Meta description' };
    const imageCopy = { headline: 'Revised image headline', cta: 'Start here' };
    mocks.list.mockResolvedValue([original]); mocks.hydrate.mockResolvedValue(hydrate(original));
    mocks.plan.mockResolvedValue({ concept: { index: 1, format: 'direct-response', copy: adCopy, adCopy, imageCopy, strategy: changed, selectionReason: 'Changed strategy' }, plannerModel: 'gpt-6-astra', reasoningEffort: 'medium' });
    const response = await call({ operation, instruction: 'Use a different composition.' });
    const { creative } = await response.json();
    expect(response.status).toBe(201);
    expect(mocks.plan.mock.calls[0][0].parent).toMatchObject({ copy: original.adCopy, adCopy: original.adCopy, imageCopy: original.imageCopy });
    expect(mocks.generate.mock.calls[0][0].concept).toMatchObject({ copy: adCopy, adCopy, imageCopy });
    expect(creative.copy).toEqual(adCopy);
    expect(creative.adCopy).toEqual(adCopy);
    expect(creative.imageCopy).toEqual(imageCopy);
  });
  it.each([
    ['adCopy-only', (record: CreativeRecord) => { record.adCopy = { ...record.copy }; }],
    ['imageCopy-only', (record: CreativeRecord) => { record.imageCopy = { headline: 'Image only' }; }],
    ['copy/adCopy mismatch', (record: CreativeRecord) => { record.adCopy = { ...record.copy, headline: 'Mismatch' }; record.imageCopy = { headline: 'Image copy' }; }],
  ])('rejects invalid saved %s state before hydration, providers, or child save', async (_name, mutate) => {
    const record = parent(); mutate(record); mocks.list.mockResolvedValue([record]);
    const response = await call({ operation: 'REGENERATE' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Saved creative has an invalid separated ad/image copy contract.' });
    expect(mocks.hydrate).not.toHaveBeenCalled();
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.saveImage).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('validates before branding and persists only the final image before returning success', async () => {
    mocks.hydrate.mockResolvedValue({ ...hydrate(parent()), logoOverlay: { buffer: Buffer.from('logo') } });
    let release!: (records: CreativeRecord[]) => void;
    mocks.save.mockImplementation(records => new Promise(resolve => { release = () => resolve(records); }));
    let finished = false;
    const pending = call({ operation: 'REGENERATE' }).then(value => { finished = true; return value; });
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(mocks.validate.mock.invocationCallOrder[0]).toBeLessThan(mocks.logo.mock.invocationCallOrder[0]);
    expect(mocks.logo.mock.invocationCallOrder[0]).toBeLessThan(mocks.saveImage.mock.invocationCallOrder[0]);
    expect(await mocks.saveImage.mock.calls[0][0].text()).toBe('final branded');
    release([]); expect((await pending).status).toBe(201);
  });
  it('rejects invalid body and IDs or missing parent before provider work', async () => {
    expect((await call({ operation: 'EDIT', instruction: '' })).status).toBe(400);
    expect((await call({ operation: 'REGENERATE' }, 'bad')).status).toBe(400);
    mocks.list.mockResolvedValue([]);
    expect((await call({ operation: 'REGENERATE' })).status).toBe(404);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.requireOperatorQuota).toHaveBeenCalledTimes(1);
  });
  it.each([429, 503])('rejects quota admission %i before creative storage, hydration, provider, or saving', async status => {
    mocks.requireOperatorQuota.mockResolvedValue(new Response(JSON.stringify({ error: 'Quota unavailable.' }), { status }));
    const response = await call({ operation: 'REGENERATE' });
    expect(response.status).toBe(status);
    expect(mocks.requireOperatorQuota).toHaveBeenCalledWith('operator', 'CREATIVE_REVISION', 1);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.hydrate).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.saveImage).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('preserves actionable hydration errors and rejects invalid images before saving', async () => {
    mocks.hydrate.mockRejectedValueOnce(new CreativeRevisionHydrationError('Reanalyze the original video.', 409));
    const missing = await call({ operation: 'REGENERATE' });
    expect(missing.status).toBe(409); expect(await missing.json()).toEqual({ error: 'Reanalyze the original video.' });
    expect(mocks.generate).not.toHaveBeenCalled();
    mocks.validate.mockRejectedValueOnce(new GeneratedImageValidationError('Wrong dimensions.'));
    expect((await call({ operation: 'REGENERATE' })).status).toBe(422);
    expect(mocks.saveImage).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(['plan', 'generate', 'logo', 'saveImage', 'save'] as const)('does not return a successful creative when %s fails', async boundary => {
    if (boundary === 'logo') mocks.hydrate.mockResolvedValue({ ...hydrate(parent()), logoOverlay: { buffer: Buffer.from('logo') } });
    mocks[boundary].mockRejectedValueOnce(new Error('internal details'));
    const response = await call(boundary === 'plan' ? { operation: 'EDIT', instruction: 'Change color' } : { operation: 'REGENERATE' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Creative revision could not be completed. The saved original is unchanged.' });
  });
});
