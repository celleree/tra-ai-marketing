import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import nextConfig from '@/next.config';
const { clerk, send, write } = vi.hoisted(() => ({ clerk: vi.fn(() => vi.fn()), send: vi.fn(), write: vi.fn() }));
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: clerk }));
vi.mock('@/lib/auth/server-access', () => ({ isClerkConfigured: () => false }));
vi.mock('@aws-sdk/client-s3', async original => ({ ...await original<typeof import('@aws-sdk/client-s3')>(), S3Client: vi.fn(function() { return { send }; }) }));
vi.mock('fs/promises', () => ({ readFile: vi.fn(), writeFile: write, mkdir: vi.fn() }));
import proxy from '@/proxy';
import { listCreatives, saveCreativeBatch, updateCreativeReviewState } from '@/lib/creatives/storage';
import { recoveryDisplayRecord } from '@/lib/recovery/read-only';

const record = {
  id: `creative_${'a'.repeat(32)}`, createdAt: '2026-10-15T00:00:00.000Z', category: 'customer-problems',
  image: { id: `media_${'b'.repeat(32)}`, fileName: `media_${'b'.repeat(32)}.png`, originalName: 'saved.png', mimeType: 'image/png', size: 128, url: `/api/media/files/media_${'b'.repeat(32)}.png` },
  copy: { primaryText: 'Saved words', headline: 'Saved headline', description: 'Saved disclosure' },
  humanReview: { status: 'PENDING' }, lifecycle: { status: 'ACTIVE', updatedAt: '2026-10-15T00:00:00.000Z' },
  planning: { futureLayout: true }, videoFrameSelection: { futureSelectedFrames: 11 },
  generationProvenance: { imageGeneration: { routing: { actualModel: 'saved-model' } }, revision: { logoOverlay: { anchor: 'top-left' } } },
};
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('dedicated compatible recovery build', () => {
  it('compiles read-only mode into this recovery candidate', () => {
    expect(nextConfig.env?.TRA_RECOVERY_READ_ONLY).toBe('true');
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('blocks %s before any handler or auth-side effect', method => {
    vi.stubEnv('TRA_RECOVERY_READ_ONLY', 'true');
    const result = proxy(new NextRequest('https://tra.example/api/creatives/generate', { method }), {} as never) as Response;
    expect(result.status).toBe(503); expect(clerk).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it.each(['/api/video/intelligence/jobs', '/api/company/fonts/analyze', '/api/media/upload-url', '/api/creatives/recovery', '/trpc/anything'])('blocks unreviewed GET handler %s', path => {
    vi.stubEnv('TRA_RECOVERY_READ_ONLY', 'true');
    expect((proxy(new NextRequest('https://tra.example' + path), {} as never) as Response).status).toBe(503);
  });
  it.each(['/api/creatives', `/api/media/files/media_${'b'.repeat(32)}.png`, `/api/media/files/media_${'b'.repeat(32)}.mp4`])('retains the normal protected read path %s', path => {
    vi.stubEnv('TRA_RECOVERY_READ_ONLY', 'true');
    expect((proxy(new NextRequest('https://tra.example' + path), {} as never) as Response).headers.get('x-middleware-next')).toBe('1');
  });
  it('loads current saved image/copy/review fields without accepting or rewriting new provenance', async () => {
    vi.stubEnv('TRA_RECOVERY_READ_ONLY', 'true'); vi.stubEnv('NODE_ENV', 'production');
    for (const key of ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET_NAME']) vi.stubEnv(key, 'offline');
    const original = JSON.stringify({ version: 1, items: [record] });
    send.mockResolvedValue({ ETag: 'unchanged', Body: { transformToString: async () => original } });
    const [saved] = await listCreatives();
    expect(saved.copy).toEqual(record.copy); expect(saved.image).toEqual(record.image);
    expect(saved.humanReview).toEqual(record.humanReview); expect(saved.lifecycle).toEqual(record.lifecycle);
    expect(saved.planning).toBeUndefined(); expect(saved.generationProvenance).toBeUndefined();
    expect(JSON.stringify({ version: 1, items: [record] })).toBe(original);
    expect(send).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled();
    await expect(saveCreativeBatch([saved])).rejects.toThrow('Read-only recovery');
    await expect(updateCreativeReviewState(saved.id, { humanReview: { status: 'PENDING' } })).rejects.toThrow('Read-only recovery');
    expect(send).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled();
  });
  it('does not weaken ordinary readers outside the dedicated recovery mode', () => {
    vi.stubEnv('TRA_RECOVERY_READ_ONLY', '');
    expect(recoveryDisplayRecord(record)).toBe(record);
  });
});
