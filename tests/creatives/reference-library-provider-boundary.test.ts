import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderPlannedCreative } from '@/lib/creatives/render-planned';
import { newCreativePortfolio } from '@/lib/creatives/portfolio-job';
import { portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';
import { referenceCandidate } from '../fixtures/reference-catalog';
const mocks = vi.hoisted(() => ({ library: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/references/storage', () => ({ listReferenceLibrary: mocks.library }));
vi.mock('@/lib/creatives/generated-image-validation', () => ({ validateGeneratedCreativeImage: vi.fn() }));
vi.mock('@/lib/creatives/storage', () => ({ saveCreativeBatch: mocks.save }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('library layout final provider byte boundary', () => {
  it.each(['valid', 'missing', 'changed'] as const)('uses a blueprint and excludes library image bytes: %s', async state => {
    vi.stubEnv('OPENAI_API_KEY', 'offline-fixture');
    const libraryBytes = Buffer.from('EXTERNAL_LIBRARY_IMAGE_BYTES');
    const reference = { ...referenceCandidate('7'), priority: 'library' as const,
      sourceSha256: createHash('sha256').update(libraryBytes).digest('hex') };
    const request = { ...portfolioRequest(1), peoplePercent: 0, useReferenceLibrary: true };
    const snapshot = portfolioSnapshot(newCreativePortfolio(request)), concept = snapshot.batchPlan.creatives[0];
    concept.strategy.execution.taxDocumentReference = 'none';
    concept.strategy.referenceSelection = { angleSource: null, layoutSource: reference.referenceId, referenceRelationship: 'mixed' };
    mocks.library.mockResolvedValue(state === 'missing' ? [] : [{ id: reference.referenceId, referenceType: 'layout' }]);
    mocks.save.mockImplementation(async records => records.map((record: object) => ({ ...record, createdAt: '2026-10-15T00:00:00Z' })));
    const fetchMock = vi.fn(async () => Response.json({ data: [{ b64_json: Buffer.from('provider-image').toString('base64') }] }));
    vi.stubGlobal('fetch', fetchMock);
    const storage = { readImageById: vi.fn(async () => ({ buffer: state === 'changed' ? Buffer.from('changed') : libraryBytes })),
      saveImage: vi.fn(async () => ({ id: `media_${'1'.repeat(32)}`, fileName: 'generated.png', originalName: 'generated.png', mimeType: 'image/png', size: 5, url: '/generated.png' })) } as any;
    const work = () => renderPlannedCreative(concept, { request, batchPlan: snapshot.batchPlan, referenceCatalog: [reference], selectedReferences: [],
      requestedSources: [], analysisSources: [], reserveLogoArea: false, brandLogo: null, videoFrameSet: null, storage });
    if (state !== 'valid') {
      await expect(work()).rejects.toThrow('unavailable or changed'); expect(fetchMock).not.toHaveBeenCalled(); return;
    }
    await work(); expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    const body = JSON.parse(init.body as string);
    expect(body.prompt).toContain('CENTERED_STACK'); expect(body).not.toHaveProperty('image');
    expect(init.body).not.toContain(libraryBytes.toString('base64')); expect(init.body).not.toContain(libraryBytes.toString());
    expect(body.prompt).toContain('Do not depict a person');
  });
});
