import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POST, GET, PATCH } from '@/app/api/creatives/portfolios/route';
import { validateGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { claimCreativePortfolio, finishPortfolioInitialPlan, newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { parseCreativePortfolioJob } from '@/lib/creatives/portfolio-job-parser';
import { advancePortfolioPreparation } from '@/lib/creatives/portfolio-preparation';
import { snapshotCreativePortfolio } from '@/lib/creatives/portfolio-snapshot';
import { hydrateReviewClaim } from '@/lib/video/review-selection-sources';
import { blank, choices, profile, review, caseStudy, library, manifest, locator } from '../fixtures/video-review-selection';
import { MemoryPortfolioStorage, portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';
import { portfolioAudit } from '../fixtures/portfolio-audit';
import { conceptDetails } from '../fixtures/creative-concept-details';

const mocks = vi.hoisted(() => ({ load: vi.fn(), storage: vi.fn(), hydrate: vi.fn(), render: vi.fn(), videoSource: vi.fn() }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: async () => ({ allowed: true, userId: 'operator' }) }));
vi.mock('@/lib/video/review-selection-store', () => ({ loadVideoReviewDraftWithFrameContext: mocks.load }));
vi.mock('@/lib/video/review-selection-sources', async original => ({ ...await original<typeof import('@/lib/video/review-selection-sources')>(), loadReviewVideoSource: mocks.videoSource }));
vi.mock('@/lib/video/intelligence-storage', async original => ({ ...await original<typeof import('@/lib/video/intelligence-storage')>(), getVideoIntelligenceStorage: mocks.storage }));
vi.mock('@/lib/creatives/generation-sources', async original => ({ ...await original<typeof import('@/lib/creatives/generation-sources')>(), hydrateGenerationSources: mocks.hydrate }));
vi.mock('@/lib/references/storage', () => ({ listAllReferenceLibrary: async () => [], listReferenceLibrary: async () => [] }));
vi.mock('@/lib/video/approved-human-planning', () => ({ loadApprovedHumanOptions: async () => [] }));
vi.mock('@/lib/proof/storage', () => ({ listProofRecords: async () => [review, caseStudy] }));
vi.mock('@/lib/creatives/storage', () => ({ listCreatives: async () => [] }));
vi.mock('@/lib/creatives/render-planned', () => ({ renderPlannedCreative: mocks.render }));

const analysis = { summary: '', visibleText: [], visualStructure: '', hookOrAngle: '', offerOrCta: '', styleNotes: '',
  preserve: [], avoid: [], unknowns: [], dominantCategory: 'customer-problems' as const };
const draftId = `review_${'a'.repeat(32)}`, revision = 'saved-revision';
const reference = { draftId, revision };
const idempotency = '11111111-1111-4111-8111-111111111111';
let storage: MemoryPortfolioStorage, outbound: any[], failAudit: boolean, repeatAudit: boolean;
const loadFixture = (selected: ReturnType<typeof choices> = { ...blank(), companyProfile: profile, claims: choices().claims!.slice(2) }) => {
  const claimSnapshots = selected.claims?.map(claim => hydrateReviewClaim(claim, selected, { library, manifest } as never, [review, caseStudy])) ?? [];
  return { revision, issues: [], draft: { version: 1, artifactType: 'VIDEO_REVIEW_DRAFT', providerEligible: false,
    id: draftId, updatedAtMs: 1000, choices: selected, claimSnapshots }, transcriptContext: selected.video ? library.transcript : null,
    selectedFrameContexts: selected.frames?.map(binding => ({ binding, observationSourceFrameId: binding.representativeFrameId,
      observationIsExactFrame: binding.candidateIndex === 0, observation: library.representativeFrames[0].observation })) ?? null };
};
const input = () => ({ ...portfolioRequest(), context: 'Explain options', companyProfile: profile, videoReview: reference });
const http = (body?: unknown, id?: string) => new Request('http://localhost/api/creatives/portfolios' + (id ? `?id=${id}` : ''),
  body === undefined ? undefined : { method: 'POST', headers: { 'Idempotency-Key': idempotency }, body: JSON.stringify(body) });
const step = (id: string) => PATCH(http({ id, action: 'advance' }));
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('OPENAI_API_KEY', 'offline-fixture'); storage = new MemoryPortfolioStorage();
  vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  outbound = []; failAudit = false; repeatAudit = false;
  mocks.storage.mockReturnValue(storage); mocks.load.mockResolvedValue(loadFixture());
  mocks.videoSource.mockResolvedValue({ library, manifest });
  mocks.hydrate.mockResolvedValue({ storage: {}, requestedSources: [], providerImageSource: null, videoFrameSet: null,
    brandLogo: null, reserveLogoArea: false });
  mocks.render.mockRejectedValue(new Error('Offline render boundary'));
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body), payload = JSON.parse(body.input[1].content[0].text);
    outbound.push(payload); expect(body.model).toBe('gpt-6-astra'); expect(body.reasoning.effort).toBe('medium');
    const audit = body.text.format.name === 'tra_portfolio_audit';
    if (audit && failAudit) { failAudit = false; throw new Error('Lost audit response'); }
    let result: unknown;
    if (audit) {
      result = repeatAudit ? { ...portfolioAudit(2), groups: [{ conceptIndexes: [1, 2], proposition: 'Same', distinction: 'Repeated' }] } : portfolioAudit(2);
      repeatAudit = false;
    } else {
      const creatives = portfolioSnapshot(newCreativePortfolio(portfolioRequest())).batchPlan.creatives.map(concept => ({ ...concept,
        strategy: { ...concept.strategy, conceptDetails: { ...conceptDetails, proposition: `Distinct ${concept.index}` } },
        proofSelection: null, referenceChoices: { angleSource: null, layoutSource: null } }));
      result = { creatives: payload.replacementIndexes ? creatives.filter(c => payload.replacementIndexes.includes(c.index)) : creatives };
    }
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('admits only a server-resolved reference and reconciles lost POST responses without rereading an edited draft', async () => {
  const response = await POST(http(input())); expect(response.status).toBe(201);
  const id = (await response.json()).job.id, job = (await readCreativePortfolio(id, storage))!;
  expect(job.request.reviewHandoff?.claimSnapshots).toEqual(loadFixture().draft.claimSnapshots);
  expect(job.slots).toHaveLength(2); expect(fetch).not.toHaveBeenCalled();
  mocks.load.mockRejectedValue(new Error('Draft changed or deleted'));
  expect((await POST(http(input()))).status).toBe(201); expect(mocks.load).toHaveBeenCalledTimes(1);
  expect(await readCreativePortfolio(id, storage)).toEqual(job);
  expect((await POST(http({ ...input(), videoReview: { ...reference, revision: 'new' } }))).status).toBe(409);
  expect((await GET(http(undefined, id))).status).toBe(200); expect(fetch).not.toHaveBeenCalled();
  for (const bad of [{ videoReview: { ...reference, choices: choices() } }, { videoReview: null }, { reviewHandoff: job.request.reviewHandoff },
    { videoFrameSelection: {} }, { videoReview: { ...reference, revision: '' } }]) {
    expect((await POST(http({ ...input(), ...bad }))).status).toBe(400);
  }
  expect(validateGenerateCreativeRequest(input()).success).toBe(false); // Legacy generate cannot silently ignore review selections.
});

it.each(['revision', 'source', 'profile', 'role'])('rejects %s drift before identities, quota or provider work are persisted', async failure => {
  const saved = loadFixture(choices()); mocks.load.mockResolvedValue(saved);
  const body = { ...input(), sourceAssets: [{ mediaId: locator.sourceVideoMediaId, role: 'TRA_VIDEO' }] };
  if (failure === 'revision') saved.revision = 'changed';
  if (failure === 'source' || failure === 'profile') saved.issues = [{ message: 'Selected source changed' }] as never;
  if (failure === 'role') body.sourceAssets[0].role = 'LAYOUT_REFERENCE';
  expect((await POST(http(body))).status).toBe(409); expect(storage.data.size).toBe(0); expect(fetch).not.toHaveBeenCalled();
});

it.each([null, []])('preserves automatic selection for empty reviewed frame/claim state %j', async state => {
  mocks.load.mockResolvedValue(loadFixture({ ...blank(), frames: state, claims: state }));
  const parsed = validateGenerateCreativeRequest(input(), 36); if (!parsed.success) throw new Error(parsed.error);
  const job = await createCreativePortfolio(parsed.data, storage);
  expect(job.request.reviewHandoff?.operatorSelectedSourceGuidance).toMatchObject({ frameMode: 'AUTOMATIC', frames: state, statements: state });
  expect(await readCreativePortfolio(job.id, storage)).toEqual(job);
});

it('freezes actual initial/audit/repair/re-audit payloads through reopen, explicit Retry and terminal replan without resetting identities', async () => {
  const id = (await (await POST(http(input()))).json()).job.id;
  let job = (await readCreativePortfolio(id, storage))!;
  const guidance = job.request.reviewHandoff!.operatorSelectedSourceGuidance, slots = job.slots;
  for (let i = 0; i < 4 && job.planning.phase === 'INITIAL_PLAN'; i++) { await step(id); job = (await readCreativePortfolio(id, storage))!; }
  expect(job.planning.phase).toBe('DIVERSITY_AUDIT');
  mocks.load.mockRejectedValue(new Error('Mutable draft must not be read on resume'));
  const calls = outbound.length; await GET(http(undefined, id)); expect(outbound).toHaveLength(calls);
  failAudit = true; await step(id); expect((await readCreativePortfolio(id, storage))!.planningError).toBeTruthy();
  await step(id); expect(outbound).toHaveLength(calls + 1); // No implicit retry after uncertain paid work.
  await PATCH(http({ id, action: 'retry', slotIndex: null })); repeatAudit = true; await step(id);
  expect((await readCreativePortfolio(id, storage))!.planning.phase).toBe('TARGETED_REPAIR');
  await step(id); repeatAudit = true; await step(id); // Known failure after the one allowed repair.
  await PATCH(http({ id, action: 'retry', slotIndex: null }));
  job = (await readCreativePortfolio(id, storage))!; expect(job.planning).toMatchObject({ phase: 'INITIAL_PLAN', preparation: { quotaReserved: true } });
  for (let i = 0; i < 5 && !job.snapshot; i++) { await step(id); job = (await readCreativePortfolio(id, storage))!; }
  expect(job.snapshot?.request.reviewHandoff).toEqual(job.request.reviewHandoff); expect(job.slots).toEqual(slots);
  expect(job.snapshot?.batchPlan.creatives.every(c => c.selectedProof === null)).toBe(true);
  for (const payload of outbound) expect(payload.operatorSelectedSourceGuidance).toEqual(guidance);
  expect(outbound.find(payload => payload.replacementIndexes)?.replacementIndexes).toEqual([2]);
  expect(mocks.load).toHaveBeenCalledTimes(1);
  await expect(updateCreativePortfolio(id, current => ({ ...current, request: { ...current.request, reviewHandoff: undefined } }), storage)).rejects.toThrow('may not replace');
  const corrupt = structuredClone(job); (corrupt.request.reviewHandoff!.choices as any).claims = [];
  expect(() => parseCreativePortfolioJob(Buffer.from(JSON.stringify(corrupt)), id)).toThrow('invalid');
});

it('delivers exact nonrepresentative selected frames to planning but fails closed before automatic human substitution', async () => {
  mocks.load.mockResolvedValue(loadFixture(choices()));
  const parsed = validateGenerateCreativeRequest({ ...input(), sourceAssets: [{ role: 'TRA_VIDEO', mediaId: locator.sourceVideoMediaId }] }, 36);
  if (!parsed.success) throw new Error(parsed.error);
  const job = await createCreativePortfolio(parsed.data, storage);
  const result = await advancePortfolioPreparation(job.request, 'http://localhost', { quotaReserved: true, analysis, selectedReferences: [], referenceCatalog: [] }, () => {}, 1);
  if (!result.prepared) throw new Error('Missing plan');
  expect(outbound[0].operatorSelectedSourceGuidance.frames[1]).toMatchObject({ observationIsExactFrame: false, binding: { candidateIndex: 1 } });
  result.prepared.batchPlan.creatives[0].strategy.execution.subjectSource = 'approved-tra-human';
  await step(job.id); // Normal planning quota reservation precedes the frozen plan checkpoint.
  await updateCreativePortfolio(job.id, current => claimCreativePortfolio(current, Date.now(), 'plan').job, storage);
  await updateCreativePortfolio(job.id, current => finishPortfolioInitialPlan(current, 'plan', {
    snapshot: snapshotCreativePortfolio(result.prepared!), plannerArgs: result.prepared!.plannerArgs!,
  }), storage);
  const corrupt = (await readCreativePortfolio(job.id, storage))!;
  if (corrupt.planning.phase !== 'DIVERSITY_AUDIT') throw new Error('Missing audit');
  delete corrupt.planning.checkpoint.plannerArgs.operatorSelectedSourceGuidance;
  expect(() => parseCreativePortfolioJob(Buffer.from(JSON.stringify(corrupt)), job.id)).toThrow('invalid');
  await step(job.id); const before = outbound.length; await step(job.id);
  expect((await readCreativePortfolio(job.id, storage))!.slots[0]).toMatchObject({ status: 'RETRY_REQUIRED', error: expect.stringContaining('closed-pool') });
  expect(mocks.render).not.toHaveBeenCalled(); expect(outbound).toHaveLength(before);
  await PATCH(http({ id: job.id, action: 'retry', slotIndex: 1 }));
  mocks.videoSource.mockRejectedValue(new Error('Frozen video source hash or library revision changed'));
  await step(job.id); expect(outbound).toHaveLength(before);
  expect((await readCreativePortfolio(job.id, storage))!.slots[0].error).toContain('Frozen video source');
  expect(mocks.render).not.toHaveBeenCalled();
});
