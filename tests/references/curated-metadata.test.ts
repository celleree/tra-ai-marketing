import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { referenceCandidate } from '../fixtures/reference-catalog';
import { conceptDetails } from '../fixtures/creative-concept-details';
import { portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { parseReferenceCuratedMetadata } from '@/lib/references/types';
vi.mock('@/lib/auth/require-operator', () => ({ requireOperatorAccess: async () => null }));
let dir: string;
beforeEach(async () => {
  vi.resetModules(); dir = await mkdtemp(join(tmpdir(), 'a33-'));
  vi.stubEnv('REFERENCE_LIBRARY_INDEX', join(dir, 'references.json'));
  vi.stubEnv('LAYOUT_BLUEPRINT_CACHE_DIR', join(dir, 'cache'));
  vi.stubEnv('OPENAI_API_KEY', 'mock'); vi.stubEnv('NODE_ENV', 'test');
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });
const candidate = referenceCandidate();
const request = (patch: unknown) => new Request('http://localhost/api/references', { method: 'PATCH',
  body: JSON.stringify({ id: candidate.referenceId, ...patch as object }), headers: { 'Content-Type': 'application/json' } });

it.each(['layout', 'tra'] as const)('edits, clears and reloads %s records through real PATCH/storage/catalog/Astra without analysis', async referenceType => {
  const { addToReferenceLibrary, listAllReferenceLibrary } = await import('@/lib/references/storage');
  const { GET, PATCH } = await import('@/app/api/references/route');
  const { withCuratedReferenceMetadata, advanceReferenceAngles } = await import('@/lib/references/planning.server');
  const { parseReferenceCatalog } = await import('@/lib/references/planning');
  const { requestCreativeBatch } = await import('@/lib/ai/creative-planner');
  const { getLayoutBlueprintCache } = await import('@/lib/layouts/service');
  await addToReferenceLibrary([{ media: { id: candidate.referenceId, fileName: `${candidate.referenceId}.png`,
    originalName: 'Legacy image', mimeType: 'image/png', size: 10, url: '/legacy.png' }, referenceType,
    angle: 'customer-problems', angleSource: 'manual' }]);
  expect((await listAllReferenceLibrary())[0]).not.toHaveProperty('notes');
  expect(await withCuratedReferenceMetadata([candidate])).toEqual([candidate]);
  await getLayoutBlueprintCache().write(candidate.sourceSha256, candidate.analyzerModel, candidate.blueprint);
  const reusableAngle = { version: 1 as const, sourceSha256: candidate.sourceSha256,
    analyzerModel: 'gpt-5.6-terra', angleSummary: 'MACHINE_SUMMARY' };
  await getLayoutBlueprintCache().writeAngle(reusableAngle);
  const prepared = { ...candidate, reusableAngle };
  for (const patch of [{ notes: ' Editorial note\nsecond line ', tags: [' calm ', 'simple', 'calm'] },
    { notes: 'Edited note' }, { notes: '', tags: [] }]) {
    expect((await PATCH(request(patch))).status).toBe(200);
    const reloaded = (await (await GET()).json()).items[0];
    expect(reloaded).toEqual((await listAllReferenceLibrary())[0]);
    expect(reloaded.angleSource).toBe('manual'); expect(reloaded.referenceType).toBe(referenceType);
    const catalog = await withCuratedReferenceMetadata([prepared]);
    expect(catalog[0].curated).toEqual(reloaded.notes ? { notes: reloaded.notes, tags: ['calm', 'simple'] } : undefined);
    expect(parseReferenceCatalog(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog);
    const start = vi.fn();
    expect(await advanceReferenceAngles(catalog, {} as never, start)).toBeNull(); expect(start).not.toHaveBeenCalled();
    expect(await getLayoutBlueprintCache().readAngle(candidate.sourceSha256, reusableAngle.analyzerModel)).toEqual(reusableAngle);
    expect(await getLayoutBlueprintCache().read(candidate.sourceSha256, candidate.analyzerModel)).toEqual(candidate.blueprint);
    const creatives = portfolioSnapshot(newCreativePortfolio(portfolioRequest())).batchPlan.creatives.map(c => ({ ...c,
      strategy: { ...c.strategy, conceptDetails: { ...conceptDetails, proposition: `Distinct ${c.index}` },
        execution: { ...c.strategy.execution, taxDocumentReference: 'none' } }, referenceChoices: { angleSource: null, layoutSource: null } }));
    vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); expect(body.model).toBe('gpt-6-astra');
      const outbound = JSON.parse(body.input[1].content[0].text);
      expect(outbound.referenceCatalog[0].curated).toEqual(catalog[0].curated);
      expect(outbound.referenceCatalog[0].reusableAngleSummary).toBe('MACHINE_SUMMARY');
      expect(body.input[0].content[0].text).toContain('never grant evidence');
      return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ creatives }) }] }] });
    });
    await requestCreativeBatch({ count: 2, context: 'CAMPAIGN_RATIONALE', analysis: {} as never,
      hasApprovedHumanSource: false, referenceCatalog: catalog });
  }
  expect(fetch).toHaveBeenCalledTimes(3); // Only requested planner calls; edits/reads/enrichment made none.
  expect((await listAllReferenceLibrary())[0]).not.toHaveProperty('notes');
  expect((await listAllReferenceLibrary())[0]).not.toHaveProperty('tags');
  const bytes = await readFile(join(dir, 'references.json'), 'utf8');
  expect((await PATCH(request({ notes: 'x'.repeat(2001) }))).status).toBe(400);
  expect(await readFile(join(dir, 'references.json'), 'utf8')).toBe(bytes);
}, 15000);

it.each([{ notes: null }, { tags: 'bad' }, { tags: [3] }, { tags: Array(11).fill('tag') },
  { tags: ['x'.repeat(41)] }, { notes: 'x'.repeat(2001) }])('rejects invalid metadata %j', value => {
  expect(parseReferenceCuratedMetadata(value)).toBeNull();
});
