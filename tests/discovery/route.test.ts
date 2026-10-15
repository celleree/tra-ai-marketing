import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ access: vi.fn(), load: vi.fn(), save: vi.fn(), saveImage: vi.fn(), remove: vi.fn(), register: vi.fn(), download: vi.fn(), start: vi.fn(), storeImage: vi.fn(), analyze: vi.fn(), quota: vi.fn() }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.access }));
vi.mock('@/lib/discovery/storage', () => ({ loadSession: mocks.load, saveSession: mocks.save, updateSession: async (_user: string, _id: string, update: (value: unknown) => void) => { const { session } = await mocks.load(); update(session); await mocks.save(); return session; } }));
vi.mock('@/lib/discovery/provider', () => ({ providerAvailable: () => false, assertProviderAvailable: vi.fn(), startSearch: mocks.start, readRun: vi.fn(), readDataset: vi.fn() }));
vi.mock('@/lib/discovery/media', () => ({ downloadSelectedImage: mocks.download }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: () => ({ saveImage: mocks.saveImage, deleteImage: mocks.remove }) }));
vi.mock('@/lib/references/storage', () => ({ addToReferenceLibrary: mocks.register }));
vi.mock('@/lib/discovery/import', () => ({ storeSelectedImage: mocks.storeImage }));
vi.mock('@/lib/discovery/analysis', () => ({ analyzeVisualPattern: mocks.analyze, visualAnalysisAvailable: () => false, assertVisualAnalysisAvailable: vi.fn() }));
vi.mock('@/lib/quotas/require-quota', () => ({ requireOperatorQuota: mocks.quota }));
vi.mock('@/lib/discovery/fingerprint', () => ({ fingerprintImage: async () => ({ byteSha256: 'a'.repeat(64), pixelSha256: 'b'.repeat(64), dHash: '0'.repeat(16), width: 16, height: 16 }) }));
import { POST } from '@/app/api/discovery/route';
import { GET as preview } from '@/app/api/discovery/preview/route';
import { extractCandidates, sampleRows } from '@/lib/discovery/model';
const request = (body: unknown) => new Request('http://localhost/api/discovery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const media = { id: 'media_123', fileName: 'media_123.png', mimeType: 'image/png', originalName: 'ref', size: 8, url: '/api/media/files/media_123.png' };
let session: Record<string, any>;
beforeEach(() => {
  vi.clearAllMocks(); mocks.access.mockResolvedValue({ allowed: true, userId: 'operator-A' });
  session = { version: 1, id: 'a'.repeat(32), sample: false, search: { query: 'consultation', limit: 10, preferTax: true }, candidates: extractCandidates(sampleRows, 'runABC', 'apify/facebook-ads-scraper', '2026-10-15T00:00:00Z'), imports: {}, feedback: {} };
  mocks.load.mockResolvedValue({ session, etag: 'etag' }); mocks.save.mockResolvedValue(undefined); mocks.saveImage.mockResolvedValue(media); mocks.download.mockResolvedValue(new File(['fixture'], 'ref.png', { type: 'image/png' })); mocks.register.mockResolvedValue([]);
  mocks.storeImage.mockResolvedValue({ media, imageSha256: 'hash', reused: false }); mocks.quota.mockResolvedValue(null);
});
describe('authenticated review and explicit import', () => {
  it('denies unauthenticated requests before storage/provider work', async () => {
    mocks.access.mockResolvedValue({ allowed: false, status: 401, error: 'Sign in required.' });
    expect((await POST(request({ action: 'sample' }))).status).toBe(401); expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
  });
  it('reviews samples without downloading, registering or starting a provider run', async () => {
    const result = await POST(request({ action: 'sample', query: 'consultation' })); expect(result.status).toBe(200);
    expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.register).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.save.mock.calls[0][0]).toBe('operator-A');
  });
  it('uses stored candidate URL, writes provenance before library, and reuses saved media on retry', async () => {
    const payload = { action: 'import', sessionId: session.id, candidateId: session.candidates[0].id, confirmRights: true, imageUrl: 'http://127.0.0.1/ignored', userId: 'operator-B' };
    expect((await POST(request(payload))).status).toBe(200);
    expect(mocks.load).toHaveBeenCalledWith('operator-A', session.id); expect(mocks.download).toHaveBeenCalledWith(session.candidates[0].imageUrl);
    expect(session.acquisitions[session.candidates[0].id].method).toBe('provider-download');
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.register.mock.invocationCallOrder[0]);
    expect((await POST(request(payload))).status).toBe(200); expect(mocks.storeImage).toHaveBeenCalledTimes(1);
    expect(mocks.register.mock.calls[0][0][0]).toMatchObject({ angleSource: 'fallback', referenceType: 'layout' });
  });
  it('requires explicit rights, refuses sample import and discards caller performance numbers', async () => {
    const payload = { action: 'import', sessionId: session.id, candidateId: session.candidates[0].id };
    expect((await POST(request(payload))).status).toBe(400); expect(mocks.download).not.toHaveBeenCalled();
    session.sample = true; expect((await POST(request({ ...payload, confirmRights: true }))).status).toBe(400);
    const feedback = { ...payload, action: 'feedback', decision: 'approved', optIn: true, spend: 500, revenue: 10000 };
    expect((await POST(request(feedback))).status).toBe(200); expect(session.feedback[session.candidates[0].id]).toBe('approved'); expect(JSON.stringify(session.feedback)).not.toContain('500');
    expect((await POST(request({ ...feedback, optIn: false }))).status).toBe(400);
  });
  it('does not register on a provenance-write conflict; the hash receipt retains reusable media', async () => {
    mocks.save.mockRejectedValueOnce(new Error('Refresh and retry.'));
    expect((await POST(request({ action: 'import', sessionId: session.id, candidateId: session.candidates[0].id, confirmRights: true }))).status).toBe(400);
    expect(mocks.register).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('never analyzes as a side effect of search/import and requires per-action transfer approval', async () => {
    expect((await POST(request({ action: 'analyze', sessionId: session.id, candidateId: session.candidates[0].id }))).status).toBe(400);
    expect(mocks.analyze).not.toHaveBeenCalled();
    await POST(request({ action: 'import', sessionId: session.id, candidateId: session.candidates[0].id, confirmRights: true })); expect(mocks.analyze).not.toHaveBeenCalled();
  });
  it('reserves a single paid analysis and preserves unknown outcomes without automatic retries', async () => {
    mocks.download.mockResolvedValue(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'ref.png', { type: 'image/png' }));
    mocks.analyze.mockRejectedValueOnce(new Error('provider connection lost'));
    const payload = { action: 'analyze', sessionId: session.id, candidateId: session.candidates[0].id, approveTransfer: true };
    expect((await POST(request(payload))).status).toBe(502); expect(session.analysisAttempts[session.candidates[0].id]).toBe('unknown');
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.analyze.mock.invocationCallOrder[0]);
    expect((await POST(request(payload))).status).toBe(409); expect(mocks.analyze).toHaveBeenCalledTimes(1);
  });
  it('serves private previews from the authenticated session candidate, never a caller URL', async () => {
    const result = await preview(new Request(`http://localhost/api/discovery/preview?session=${session.id}&candidate=${session.candidates[0].id}&url=http://127.0.0.1/ignored`));
    expect(result.status).toBe(200); expect(result.headers.get('Cache-Control')).toBe('private, no-store'); expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(mocks.load).toHaveBeenCalledWith('operator-A', session.id); expect(mocks.download).toHaveBeenCalledWith(session.candidates[0].imageUrl);
    session.sample = true; expect((await preview(new Request(`http://localhost/api/discovery/preview?session=${session.id}&candidate=${session.candidates[0].id}`))).status).toBe(404);
  });
});

it('redacts unexpected storage/network messages at the public boundary', async () => {
  mocks.load.mockRejectedValueOnce(new Error('secret-token https://cdn.example/?signature=private'));
  const result = await POST(request({ action: 'import', sessionId: session.id, candidateId: session.candidates[0].id, confirmRights: true }));
  expect(result.status).toBe(400); expect(result.headers.get('Cache-Control')).toBe('private, no-store');
  const text = await result.text(); expect(text).not.toMatch(/secret-token|signature|cdn.example/); expect(text).toContain('saved session');
});
