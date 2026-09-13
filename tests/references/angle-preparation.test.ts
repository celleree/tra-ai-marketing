import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getLayoutBlueprintCache } from '@/lib/layouts/service';
import { advanceReferenceAngles } from '@/lib/references/planning.server';
import { prepareCreativeGeneration } from '@/lib/creatives/prepare-generation';
import { advanceCreativePortfolio } from '@/lib/creatives/portfolio-execution';
import { createCreativePortfolio, readCreativePortfolio, updateCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import { newCreativePortfolio, retryPortfolioWork } from '@/lib/creatives/portfolio-job';
import { MemoryPortfolioStorage, portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';
import { referenceCandidate } from '../fixtures/reference-catalog';
import { conceptDetails } from '../fixtures/creative-concept-details';

const mocks = vi.hoisted(() => ({ media: vi.fn(), library: vi.fn(), select: vi.fn() }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: mocks.media }));
vi.mock('@/lib/references/storage', () => ({ listReferenceLibrary: mocks.library }));
vi.mock('@/lib/ai/reference-selector', () => ({ selectBestReferenceCreatives: mocks.select }));
vi.mock('@/lib/video/approved-human-planning', () => ({ loadApprovedHumanOptions: async () => [] }));
vi.mock('@/lib/creatives/storage', () => ({ listCreatives: async () => [] }));
const dir = await mkdtemp(join(tmpdir(), 'a32-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const candidate = { ...referenceCandidate(), sourceSha256: sha(png) };
const item = { id: candidate.referenceId, fileName: `${candidate.referenceId}.png`, originalName: 'Library',
  mimeType: 'image/png', size: png.length, url: '/library.png', addedAt: '2026-09-13T00:00:00Z',
  referenceType: 'layout', angle: 'educational', angleSource: 'manual' };
const source = { fileName: item.fileName, mimeType: 'image/png' as const, mediaType: 'IMAGE' as const, buffer: png };
const storage = { readImageById: vi.fn(async (_id: string) => source), readMediaById: vi.fn(async () => source) };
let semanticCalls: number, astra: any[], fail: boolean;
beforeEach(async () => {
  vi.clearAllMocks(); semanticCalls = 0; astra = []; fail = false;
  vi.stubEnv('LAYOUT_BLUEPRINT_CACHE_DIR', dir); vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('OPENAI_API_KEY', 'mock'); vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'semantic-model');
  vi.stubEnv('OPENAI_LAYOUT_ANALYSIS_MODEL', 'semantic-model');
  mocks.media.mockReturnValue(storage); mocks.library.mockResolvedValue([item]);
  mocks.select.mockResolvedValue([{ item, imageUrl: 'http://localhost/library.png', selectionReason: 'CAMPAIGN_SELECTION' }]);
  storage.readImageById.mockResolvedValue(source);
  for (const file of await readdir(dir)) await rm(join(dir, file));
  await getLayoutBlueprintCache().write(sha(png), 'semantic-model', candidate.blueprint);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'gpt-6-astra') {
      astra.push(JSON.parse(body.input[1].content[0].text));
      const creatives = portfolioSnapshot(newCreativePortfolio(portfolioRequest())).batchPlan.creatives.map(c => ({ ...c,
        strategy: { ...c.strategy, conceptDetails: { ...conceptDetails, proposition: `Distinct ${c.index}` },
          execution: { ...c.strategy.execution, taxDocumentReference: 'none' } }, referenceChoices: { angleSource: item.id, layoutSource: item.id } }));
      return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ creatives }) }] }] });
    }
    const reusable = body.text.format.name === 'reusable_reference_angle';
    if (reusable) {
      semanticCalls++;
      expect(JSON.stringify(body)).not.toContain('CAMPAIGN_SELECTION'); expect(JSON.stringify(body)).not.toContain('PRIVATE_CAMPAIGN');
      if (fail) throw new Error('Uncertain semantic provider outcome');
    }
    expect(['tra_reference_analysis', 'reusable_reference_angle']).toContain(body.text.format.name); // Never a blueprint or render call.
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Observation',
      hookOrAngle: reusable ? 'REUSABLE_SENTINEL' : 'CONTEXTUAL_OBSERVATION', visibleText: [], visualStructure: '',
      offerOrCta: '', styleNotes: '', preserve: [], avoid: [], unknowns: [], dominantCategory: 'educational' }) }] }] });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => rm(dir, { recursive: true, force: true }));

it.each([false, true])('connects real preparation, cache, reload and outbound Astra; uploaded=%s', async uploaded => {
  if (!uploaded) mocks.library.mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({ ...item, id: `media_${i.toString(16).padStart(32, '0')}` })));
  const data = { ...portfolioRequest(), context: 'PRIVATE_CAMPAIGN',
    sourceAssets: uploaded ? [{ role: 'LAYOUT_REFERENCE' as const, mediaId: item.id }] : [] };
  const jobs = new MemoryPortfolioStorage(), job = await createCreativePortfolio(data, jobs);
  let current = job, savedEnrichment = false;
  for (let i = 0; i < 15 && current.planning.phase === 'INITIAL_PLAN'; i++) {
    const before = vi.mocked(fetch).mock.calls.length;
    const result = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', jobs);
    expect(result.error).toBeUndefined(); current = result.job;
    expect(vi.mocked(fetch).mock.calls.length - before).toBeLessThanOrEqual(1);
    const calls = vi.mocked(fetch).mock.calls.length;
    expect(await readCreativePortfolio(job.id, jobs)).toEqual(current);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls); // GET/reopen storage read performs no work.
    if (current.planning.phase === 'INITIAL_PLAN' && current.planning.preparation.referenceCatalog?.[0]?.reusableAngle) {
      savedEnrichment = true; expect(astra).toHaveLength(0);
    }
  }
  expect(savedEnrichment).toBe(true); expect(semanticCalls).toBe(1);
  expect(mocks.select.mock.calls[0][0].requestedCount).toBeLessThanOrEqual(8);
  expect(storage.readImageById.mock.calls.every(([id]) => id === item.id)).toBe(true);
  if (current.planning.phase !== 'DIVERSITY_AUDIT') throw new Error('Initial plan not reached');
  const checkpoint = current.planning.checkpoint;
  expect(checkpoint.snapshot.referenceCatalog).toEqual(checkpoint.plannerArgs.referenceCatalog);
  expect(checkpoint.snapshot.referenceCatalog[0].reusableAngle?.angleSummary).toBe('REUSABLE_SENTINEL');
  expect(astra[0].referenceCatalog[0].reusableAngleSummary).toBe('REUSABLE_SENTINEL');
  expect(astra[0].creativeContext).toContain('CAMPAIGN_SELECTION');
  const direct = await prepareCreativeGeneration({ ...data, context: 'OTHER_CAMPAIGN' }, 'http://localhost', { initialPlanOnly: true });
  expect(semanticCalls).toBe(1); expect(astra[1].referenceCatalog[0].reusableAngleSummary).toBe('REUSABLE_SENTINEL');
  expect(direct.referenceCatalog[0].blueprint).toEqual(candidate.blueprint);
  expect(direct.providerImageSource).toBeUndefined(); expect(direct.videoFrameSet).toBeNull();
  expect(await getLayoutBlueprintCache().read(sha(png), 'semantic-model')).toEqual(candidate.blueprint);
});

it('invalidates semantic hash/model/schema and malformed entries without changing blueprints', async () => {
  const start = vi.fn(), mediaStorage = storage as unknown as Parameters<typeof advanceReferenceAngles>[1];
  await advanceReferenceAngles([candidate], mediaStorage, start);
  await advanceReferenceAngles([candidate], mediaStorage, start);
  expect(semanticCalls).toBe(1); expect(start).toHaveBeenCalledTimes(1);
  const angleFile = (await readdir(dir)).find(name => name.startsWith('angle-v1'))!;
  for (const invalid of ['{', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, angleSummary: '' })]) {
    await writeFile(join(dir, angleFile), invalid);
    await advanceReferenceAngles([candidate], mediaStorage, start);
  }
  expect(semanticCalls).toBe(4);
  vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'new-model');
  await advanceReferenceAngles([candidate], mediaStorage, start);
  expect(semanticCalls).toBe(5);
  const changed = { ...source, buffer: Buffer.concat([png, Buffer.from('changed')]) };
  storage.readImageById.mockResolvedValue(changed);
  await expect(advanceReferenceAngles([candidate], mediaStorage, start)).rejects.toThrow('changed');
  await advanceReferenceAngles([{ ...candidate, sourceSha256: sha(changed.buffer) }], mediaStorage, start);
  expect(semanticCalls).toBe(6);
  expect(await getLayoutBlueprintCache().read(sha(png), 'semantic-model')).toEqual(candidate.blueprint);
});

it('holds uncertain semantic work until explicit Retry; legacy failure requires resubmission', async () => {
  const jobs = new MemoryPortfolioStorage(), job = await createCreativePortfolio(portfolioRequest(), jobs);
  fail = true;
  let current = job;
  for (let i = 0; i < 10 && !current.planningError; i++) current = (await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', jobs)).job;
  expect(current.planningError).toBeTruthy(); expect(semanticCalls).toBe(1); expect(astra).toHaveLength(0);
  expect((await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', jobs)).job).toEqual(current);
  expect(await readCreativePortfolio(job.id, jobs)).toEqual(current); expect(semanticCalls).toBe(1);
  await expect(prepareCreativeGeneration(portfolioRequest(), 'http://localhost')).rejects.toThrow('Uncertain');
  expect(semanticCalls).toBe(2);
  fail = false;
  await updateCreativePortfolio(job.id, value => retryPortfolioWork(value, null), jobs);
  const retry = await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', jobs);
  expect(retry.error).toBeUndefined(); expect(semanticCalls).toBe(3); expect(astra).toHaveLength(0);
  expect((await advanceCreativePortfolio(job.id, 'operator', 'http://localhost', jobs)).error).toBeUndefined();
  expect(semanticCalls).toBe(3); expect(astra).toHaveLength(1);
});
