import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/creatives/[creativeId]/revise/route';
import { buildCreativeIdentity } from '@/lib/creatives/identity.server';
import { CreativeRevisionHydrationError } from '@/lib/creatives/revision-source-hydration';
import { GeneratedImageValidationError } from '@/lib/creatives/generated-image-validation';
import type { CreativeRecord } from '@/lib/creatives/generated';
import type { CreativeStrategy } from '@/lib/creatives/strategy';

const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), hydrate: vi.fn(), plan: vi.fn(), generate: vi.fn(), validate: vi.fn(), logo: vi.fn(), saveImage: vi.fn(), getOperatorAccess: vi.fn(), requireOperatorQuota: vi.fn() }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.getOperatorAccess }));
vi.mock('@/lib/quotas/require-quota', () => ({ requireOperatorQuota: mocks.requireOperatorQuota }));
vi.mock('@/lib/creatives/storage', async importOriginal => ({ ...await importOriginal<object>(), listCreatives: mocks.list, saveCreativeBatch: mocks.save }));
vi.mock('@/lib/creatives/revision-source-hydration', async importOriginal => ({ ...await importOriginal<object>(), hydrateSavedCreativeRevisionContext: mocks.hydrate }));
vi.mock('@/lib/creatives/generated-image-validation', async importOriginal => ({ ...await importOriginal<object>(), validateGeneratedCreativeImage: mocks.validate }));
vi.mock('@/lib/ai/creative-revision-planner', () => ({ planCreativeRevision: mocks.plan }));
vi.mock('@/lib/ai/creative-revision-image', () => ({ generateCreativeRevisionImage: mocks.generate }));
vi.mock('@/lib/creatives/brand-logo.server', () => ({ compositeCreativeBrandLogo: mocks.logo }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: () => ({ saveImage: mocks.saveImage }) }));

const parentId = `creative_${'a'.repeat(32)}`;
const mediaId = `media_${'b'.repeat(32)}`;
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
const call = (body: unknown, creativeId = parentId) => POST(new Request('http://localhost/api/creatives/revise', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ creativeId }) });
const hydrate = (record: CreativeRecord) => ({ parent: { record, identity: record.identity, planning: record.planning, provenance: record.generationProvenance }, canvas: { kind: 'EDITING_CANVAS', approvedHumanSource: false, mediaId, sha256: 'c'.repeat(64) }, originalApprovedSource: null, logoOverlay: null });
beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.getOperatorAccess.mockResolvedValue({ allowed: true, userId: 'operator' });
  mocks.requireOperatorQuota.mockResolvedValue(null);
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
  it.each(['REGENERATE', 'PLACEMENT'] as const)('creates a new saved %s without replanning or modifying the parent', async operation => {
    const original = parent();
    const result = await call({ operation, ...(operation === 'PLACEMENT' ? { placement: 'PORTRAIT_4_5' } : {}) });
    expect(result.status).toBe(201);
    const { creative } = await result.json();
    expect(creative.id).not.toBe(parentId);
    expect(creative.identity).toMatchObject({ operation, parentCreativeId: parentId, fingerprint: original.identity!.fingerprint, conceptId: operation === 'PLACEMENT' ? parentId : creative.id });
    expect(creative.copy).toEqual(original.copy);
    expect(creative.placement).toBe(operation === 'PLACEMENT' ? 'PORTRAIT_4_5' : 'SQUARE_1_1');
    expect(creative.generationProvenance).toMatchObject({ imageGeneration: { prompt: 'actual revision prompt', model: 'gpt-image-2.5-sunburst', routing: { preferredModel: 'gpt-image-2.5-sunburst', actualModel: 'gpt-image-2.5-sunburst', fallbackUsed: false } }, revision: { parentCreativeId: parentId, canvasMediaId: mediaId, canvasSha256: 'c'.repeat(64) } });
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.save.mock.calls[0][0]).toHaveLength(1);
    expect(mocks.list.mock.results[0].value).resolves.toEqual([original]);
  });
  it.each(['EDIT', 'VARIATION'] as const)('plans %s with current company context and stores its resulting strategy', async operation => {
    const changed = { ...strategy, awarenessStage: 'solution-aware' as const, execution: { ...strategy.execution, composition: 'split' as const, textDensity: 'medium' as const } };
    mocks.plan.mockResolvedValue({ concept: { index: 1, format: 'direct-response', copy: parent().copy, strategy: changed, selectionReason: 'Changed strategy' }, plannerModel: 'gpt-6-astra', reasoningEffort: 'medium' });
    const response = await call({ operation, instruction: 'Use a different composition.' });
    const { creative } = await response.json();
    expect(response.status).toBe(201);
    expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({ operation, hasApprovedHumanSource: false, instruction: 'Use a different composition.', companyContext: expect.stringContaining('APPROVED TRA COMPANY CONTEXT') }));
    expect(creative.planning.strategy).toEqual(changed);
    expect(creative.identity.fingerprint).not.toBe(parent().identity!.fingerprint);
    expect(creative.identity.conceptId).toBe(operation === 'EDIT' ? parentId : creative.id);
    expect(creative.generationProvenance.revision.instruction).toBe('Use a different composition.');
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
