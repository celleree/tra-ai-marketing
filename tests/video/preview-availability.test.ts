import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const getOperatorAccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess }));
import { assertDurableVideoIntelligenceAvailable, isDurableVideoIntelligenceAvailable, videoIntelligenceHttpStatus } from '@/lib/video/preview-availability';
import { GET as readJob, POST as job } from '@/app/api/video/intelligence/jobs/route';
import { POST as library } from '@/app/api/video/intelligence/library/route';
import { POST as selection } from '@/app/api/video/intelligence/selection/route';
import { POST as legacyAnalysis } from '@/app/api/video/intelligence/route';
import { POST as legacySelection } from '@/app/api/video/selection/route';
import { getApprovedPreparedSelectedTraVideoFrames } from '@/lib/video/prepared-selected-frames';

beforeEach(() => getOperatorAccess.mockResolvedValue({ allowed: true, userId: 'operator' }));
afterEach(() => vi.unstubAllEnvs());
const setEnvironment = (node: string, vercel: string) => { vi.stubEnv('NODE_ENV', node); vi.stubEnv('VERCEL_ENV', vercel); };
const malformed = () => new Request('http://localhost/test', { method: 'POST', body: '{' });

describe('durable video Preview availability', () => {
  it.each([['development', ''], ['test', ''], ['production', 'preview']])('enables %s/%s with normal error statuses', (node, vercel) => {
    setEnvironment(node, vercel);
    expect(isDurableVideoIntelligenceAvailable()).toBe(true);
    expect(() => assertDurableVideoIntelligenceAvailable()).not.toThrow();
    for (const status of [400, 409, 500]) expect(videoIntelligenceHttpStatus(status)).toBe(status);
  });

  it.each(['production', '', 'development'])('denies production runtime with VERCEL_ENV=%s before parsing or extraction', async (vercel) => {
    setEnvironment('production', vercel);
    expect(isDurableVideoIntelligenceAvailable()).toBe(false);
    expect(() => assertDurableVideoIntelligenceAvailable()).toThrow('protected Vercel Preview');
    for (const status of [400, 409, 500]) expect(videoIntelligenceHttpStatus(status)).toBe(404);
    for (const route of [job, library, selection]) expect((await route(malformed())).status).toBe(404);
    expect((await readJob(new Request('http://localhost/jobs'))).status).toBe(404);
    await expect(getApprovedPreparedSelectedTraVideoFrames(null as never, null as never, [], null as never)).rejects.toThrow('protected Vercel Preview');
  });

  it('lets Preview requests reach validation while legacy prototype routes remain denied', async () => {
    setEnvironment('production', 'preview');
    for (const route of [job, library, selection]) expect((await route(malformed())).status).toBe(400);
    expect((await readJob(new Request('http://localhost/jobs'))).status).toBe(400);
    for (const route of [legacyAnalysis, legacySelection]) expect((await route(malformed())).status).toBe(404);
  });
});
