import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceCreativePortfolio } from '@/lib/creatives/portfolio-execution';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { readCreativePortfolio } from '@/lib/creatives/portfolio-job-storage';
import type { CreativeRecord } from '@/lib/creatives/generated';
import { MemoryPortfolioStorage, portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';

const persistence = vi.hoisted(() => ({
  records: [] as CreativeRecord[],
  saveCreativeBatch: vi.fn(),
  listCreatives: vi.fn(),
}));
const media = vi.hoisted(() => ({
  saveImage: vi.fn(),
  saveMedia: vi.fn(),
  readMedia: vi.fn(),
  readMediaById: vi.fn(),
  readImage: vi.fn(),
  readImageById: vi.fn(),
  deleteImage: vi.fn(),
}));
const imageValidation = vi.hoisted(() => ({ validate: vi.fn() }));

vi.mock('@/lib/creatives/storage', () => ({
  saveCreativeBatch: persistence.saveCreativeBatch,
  listCreatives: persistence.listCreatives,
}));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: () => media }));
vi.mock('@/lib/creatives/generated-image-validation', async original => ({
  ...await original<typeof import('@/lib/creatives/generated-image-validation')>(),
  validateGeneratedCreativeImage: imageValidation.validate,
}));

const PROVIDER_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const portfolioKey = (id: string) => `creative-portfolios/v1/${id}.json`;

const readyPortfolio = (mutate?: (concept: ReturnType<typeof portfolioSnapshot>['batchPlan']['creatives'][number]) => void) => {
  const job = newCreativePortfolio(portfolioRequest(), 1_000);
  const snapshot = portfolioSnapshot(job);
  for (const concept of snapshot.batchPlan.creatives) {
    delete concept.adCopy;
    delete concept.imageCopy;
    mutate?.(concept);
  }
  return { ...job, snapshot, planning: { phase: 'READY_TO_RENDER' as const }, updatedAtMs: 2_000 };
};

const persistReadyPortfolio = async (
  storage: MemoryPortfolioStorage,
  mutate?: (concept: ReturnType<typeof portfolioSnapshot>['batchPlan']['creatives'][number]) => void,
) => {
  const job = readyPortfolio(mutate);
  expect(await storage.write(portfolioKey(job.id), Buffer.from(JSON.stringify(job)), null)).toBe(true);
  return job;
};

beforeEach(() => {
  persistence.records.length = 0;
  persistence.listCreatives.mockReset().mockImplementation(async () => persistence.records);
  persistence.saveCreativeBatch.mockReset().mockImplementation(async (records: CreativeRecord[]) => {
    persistence.records.push(...records);
    return records;
  });
  media.saveImage.mockReset().mockImplementation(async () => ({
    id: `media_${'a'.repeat(32)}`,
    fileName: `media_${'a'.repeat(32)}.png`,
    originalName: 'legacy-resumed.png',
    mimeType: 'image/png',
    size: PROVIDER_BYTES.length,
    url: '/legacy-resumed.png',
  }));
  media.readImageById.mockReset().mockResolvedValue(null);
  media.readMediaById.mockReset().mockResolvedValue(null);
  media.readImage.mockReset().mockResolvedValue(null);
  media.readMedia.mockReset().mockResolvedValue(null);
  imageValidation.validate.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('legacy copy-only portfolio resume', () => {
  it('resumes a frozen pre-E2 READY_TO_RENDER portfolio with historical copy rendering and no invented imageCopy', async () => {
    const storage = new MemoryPortfolioStorage();
    const saved = await persistReadyPortfolio(storage);
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ data: [{ b64_json: PROVIDER_BYTES.toString('base64') }] }));
    vi.stubGlobal('fetch', fetchMock);

    const reloaded = await readCreativePortfolio(saved.id, storage);
    expect(reloaded?.planning.phase).toBe('READY_TO_RENDER');
    expect(reloaded?.snapshot?.batchPlan.creatives[0]).not.toHaveProperty('adCopy');
    expect(reloaded?.snapshot?.batchPlan.creatives[0]).not.toHaveProperty('imageCopy');

    const first = await advanceCreativePortfolio(saved.id, 'operator', 'http://localhost', storage);
    expect(first.error).toBeUndefined();
    expect(first.job.slots.map(slot => slot.status)).toEqual(['SAVED', 'PENDING']);
    const second = await advanceCreativePortfolio(saved.id, 'operator', 'http://localhost', storage);
    expect(second.error).toBeUndefined();
    expect(second.job.slots.map(slot => slot.status)).toEqual(['SAVED', 'SAVED']);
    expect(second.job.slots).not.toContainEqual(expect.objectContaining({ status: 'RETRY_REQUIRED' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(firstRequest.prompt).toContain('Use this planned ad copy verbatim when rendered:');
    expect(firstRequest.prompt).toContain('Primary text: Explore options');
    expect(firstRequest.prompt).toContain('Description:');

    expect(persistence.records).toHaveLength(2);
    for (const record of persistence.records) {
      expect(record.copy.primaryText).toBe('Explore options');
      expect(record).not.toHaveProperty('adCopy');
      expect(record).not.toHaveProperty('imageCopy');
    }
    const completed = await advanceCreativePortfolio(saved.id, 'operator', 'http://localhost', storage);
    expect(completed.job.slots.every(slot => slot.status === 'SAVED')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['adCopy without imageCopy', (concept: ReturnType<typeof portfolioSnapshot>['batchPlan']['creatives'][number]) => {
      concept.adCopy = { ...concept.copy };
    }],
    ['imageCopy without adCopy', (concept: ReturnType<typeof portfolioSnapshot>['batchPlan']['creatives'][number]) => {
      concept.imageCopy = { headline: concept.copy.headline };
    }],
    ['copy/adCopy disagreement', (concept: ReturnType<typeof portfolioSnapshot>['batchPlan']['creatives'][number]) => {
      concept.adCopy = { ...concept.copy, headline: 'Different Meta headline' };
      concept.imageCopy = { headline: concept.copy.headline };
    }],
  ])('fails closed for malformed separated-copy plans: %s', async (_label, mutate) => {
    const storage = new MemoryPortfolioStorage();
    const saved = await persistReadyPortfolio(storage, mutate);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await advanceCreativePortfolio(saved.id, 'operator', 'http://localhost', storage);
    expect(result.status).toBe(409);
    expect(result.job.slots[0].status).toBe('RETRY_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistence.records).toHaveLength(0);
  });
});
