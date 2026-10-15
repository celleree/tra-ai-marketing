import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BatchControlsError } from '@/lib/creatives/batch-controls-error';
import { requestCreativeBatch } from '@/lib/ai/creative-planner';
import { advanceCreativePortfolio } from '@/lib/creatives/portfolio-execution';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { MemoryPortfolioStorage, portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';
import { referenceCandidate } from '../fixtures/reference-catalog';
const mocks = vi.hoisted(() => ({ library: vi.fn(), image: vi.fn(), select: vi.fn(), humans: vi.fn() }));
vi.mock('@/lib/references/storage', () => ({ listReferenceLibrary: mocks.library, listAllReferenceLibrary: mocks.library }));
vi.mock('@/lib/ai/reference-selector', () => ({ selectBestReferenceCreatives: mocks.select }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: () => ({ readImageById: mocks.image }) }));
vi.mock('@/lib/creatives/storage', () => ({ listCreatives: async () => [] }));
vi.mock('@/lib/video/approved-human-planning', () => ({ loadApprovedHumanOptions: mocks.humans }));
const secret = 'SECRET_PROVIDER_STORAGE_OR_CREDENTIAL_DETAIL';
// A synthetic configuration value reaches the intended guard; every test blocks network dispatch.
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('OPENAI_API_KEY', 'offline-control-fixture'); mocks.library.mockResolvedValue([]); mocks.image.mockResolvedValue(null); mocks.humans.mockResolvedValue([]); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it.each(['empty-library', 'empty-selection', 'failed-selection', 'missing-human', 'missing-render-reference', 'changed-render-reference'])('retains actionable stopped state through the real runner: %s', async reason => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetchMock = vi.fn(() => { throw new Error('NETWORK FORBIDDEN'); }); vi.stubGlobal('fetch', fetchMock);
  const storage = new MemoryPortfolioStorage();
  const job = newCreativePortfolio({ ...portfolioRequest(), peoplePercent: reason === 'missing-human' ? 50 : 0, useReferenceLibrary: reason !== 'missing-human' });
  if (reason.includes('render-reference')) {
    const reference = { ...referenceCandidate('7'), priority: 'library' as const };
    job.snapshot = portfolioSnapshot(job); job.snapshot.referenceCatalog = [reference];
    job.snapshot.batchPlan.creatives.forEach(concept => { concept.strategy.referenceSelection = { angleSource: null, layoutSource: reference.referenceId, referenceRelationship: 'mixed' }; });
    job.planning = { phase: 'READY_TO_RENDER' };
    if (reason === 'changed-render-reference') { mocks.library.mockResolvedValue([{ id: reference.referenceId, referenceType: 'layout' }]); mocks.image.mockResolvedValue({ buffer: Buffer.from('changed') }); }
  } else {
    job.planning = { phase: 'INITIAL_PLAN', preparation: { quotaReserved: true, sourceAnalysis: { version: 1, entries: [] } } };
    if (reason.includes('selection')) { mocks.library.mockResolvedValue([{ id: referenceCandidate('7').referenceId, referenceType: 'layout', url: '/library.png' }]);
      if (reason === 'failed-selection') mocks.select.mockRejectedValue(new Error(secret)); else mocks.select.mockResolvedValue([]); }
  }
  await storage.write(`creative-portfolios/v1/${job.id}.json`, Buffer.from(JSON.stringify(job)), null);
  let result = await advanceCreativePortfolio(job.id, 'offline-controls', 'http://localhost', storage);
  if (!result.error) result = await advanceCreativePortfolio(job.id, 'offline-controls', 'http://localhost', storage);
  expect(result.status, JSON.stringify(errors.mock.calls.map(call => ({ name: call[1]?.constructor?.name, message: call[1]?.message })))).toBe(409); expect(result.error).toMatch(/new portfolio|explicit.*Retry/); expect(result.error).not.toContain(secret);
  if (reason === 'missing-human') expect(result.error).toContain('Ads with people'); else expect(result.error).toMatch(/reference library|library layout/);
  expect(result.job.lease).toBeNull();
  if (job.snapshot) { expect(result.job.slots[0].status).toBe('RETRY_REQUIRED'); expect(result.job.slots[0].error).toBe(result.error); }
  else expect(result.job.planningError).toBe(result.error);
  const calls = mocks.select.mock.calls.length;
  const stopped = await advanceCreativePortfolio(job.id, 'offline-controls', 'http://localhost', storage);
  if (!job.snapshot) expect(stopped.job).toEqual(result.job);
  else expect(stopped.job.slots[0]).toEqual(result.job.slots[0]);
  expect(mocks.select).toHaveBeenCalledTimes(calls); expect(fetchMock).not.toHaveBeenCalled();
});
it.each(['library-storage', 'legacy-selector', 'credential'])('redacts unknown %s errors and preserves legacy selector behavior', async reason => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetchMock = vi.fn(() => { throw new Error('NETWORK FORBIDDEN'); }); vi.stubGlobal('fetch', fetchMock);
  const storage = new MemoryPortfolioStorage();
  const job = newCreativePortfolio({ ...portfolioRequest(), ...(reason === 'legacy-selector' ? {} : { peoplePercent: 0, useReferenceLibrary: reason === 'library-storage' }) });
  job.planning = { phase: 'INITIAL_PLAN', preparation: { quotaReserved: true, sourceAnalysis: { version: 1, entries: [] } } };
  if (reason === 'library-storage') mocks.library.mockRejectedValue(new Error(secret));
  else if (reason === 'credential') mocks.humans.mockRejectedValue(new Error(secret));
  else { mocks.library.mockResolvedValue([{ id: referenceCandidate('7').referenceId, referenceType: 'layout', url: '/library.png' }]); mocks.select.mockRejectedValue(new Error(secret)); }
  await storage.write(`creative-portfolios/v1/${job.id}.json`, Buffer.from(JSON.stringify(job)), null);
  const result = await advanceCreativePortfolio(job.id, 'offline-controls', 'http://localhost', storage);
  expect(result.status, JSON.stringify(errors.mock.calls.map(call => ({ name: call[1]?.constructor?.name, message: call[1]?.message })))).toBe(500); expect(result.error).toBe('Portfolio work could not be completed. Review its status before retrying.');
  expect(JSON.stringify(result)).not.toContain(secret); expect(fetchMock).not.toHaveBeenCalled();
});

it('uses the safe class for the actual pinned-layout conflict before any provider dispatch', async () => {
  const fetchMock = vi.fn(() => { throw new Error('NETWORK FORBIDDEN'); }); vi.stubGlobal('fetch', fetchMock);
  await expect(requestCreativeBatch({ count: 2, context: 'TRA', peoplePercent: 0, useReferenceLibrary: true,
    analysis: { summary: 'TRA', visibleText: [], visualStructure: '', hookOrAngle: '', offerOrCta: '', styleNotes: '', preserve: [], avoid: [], unknowns: [], dominantCategory: 'customer-problems' },
    hasApprovedHumanSource: false, referenceCatalog: [{ ...referenceCandidate('7'), priority: 'library' }],
    requiredLayoutReferenceIds: [referenceCandidate('4').referenceId] })).rejects.toBeInstanceOf(BatchControlsError);
  expect(fetchMock).not.toHaveBeenCalled();
});
