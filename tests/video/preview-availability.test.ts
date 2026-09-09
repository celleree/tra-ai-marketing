import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const getOperatorAccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess }));
import { assertDurableVideoIntelligenceAvailable, isDurableVideoIntelligenceAvailable, videoIntelligenceHttpStatus } from '@/lib/video/preview-availability';
import { GET as readJob, POST as job } from '@/app/api/video/intelligence/jobs/route';
import { POST as library } from '@/app/api/video/intelligence/library/route';
import { POST as selection } from '@/app/api/video/intelligence/selection/route';
import { POST as preview } from '@/app/api/video/intelligence/selected-frame-preview/route';
import { POST as legacyAnalysis } from '@/app/api/video/intelligence/route';
import { POST as legacySelection } from '@/app/api/video/selection/route';
import { getApprovedPreparedSelectedTraVideoFrames } from '@/lib/video/prepared-selected-frames';

const productionConfig = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_fixture', CLERK_SECRET_KEY: 'sk_live_fixture',
  OPENAI_API_KEY: 'fixture-provider', R2_ACCOUNT_ID: 'fixture-account',
  R2_ACCESS_KEY_ID: 'fixture-access', R2_SECRET_ACCESS_KEY: 'fixture-secret', R2_BUCKET_NAME: 'fixture-production',
};
beforeEach(() => {
  getOperatorAccess.mockResolvedValue({ allowed: true, userId: 'operator' });
  for (const name of Object.keys(productionConfig)) vi.stubEnv(name, '');
});
afterEach(() => vi.unstubAllEnvs());
const setEnvironment = (node: string, vercel: string) => { vi.stubEnv('NODE_ENV', node); vi.stubEnv('VERCEL_ENV', vercel); };
const malformed = () => new Request('http://localhost/test', { method: 'POST', body: '{' });
const configureProduction = () => {
  setEnvironment('production', 'production');
  for (const [name, value] of Object.entries(productionConfig)) vi.stubEnv(name, value);
};

describe('durable video deployment availability', () => {
  it.each([['development', ''], ['test', ''], ['production', 'preview']])('enables %s/%s with normal error statuses', (node, vercel) => {
    setEnvironment(node, vercel);
    expect(isDurableVideoIntelligenceAvailable()).toBe(true);
    expect(() => assertDurableVideoIntelligenceAvailable()).not.toThrow();
    for (const status of [400, 409, 500]) expect(videoIntelligenceHttpStatus(status)).toBe(status);
  });

  it.each(['development', 'test'])('treats Vercel Production as Production even when NODE_ENV=%s', (node) => {
    setEnvironment(node, 'production');
    expect(isDurableVideoIntelligenceAvailable()).toBe(false);
    expect(() => assertDurableVideoIntelligenceAvailable()).toThrow('configured Production');
    expect(videoIntelligenceHttpStatus(500)).toBe(404);
  });

  it.each(['production', '', 'development'])('denies production runtime with VERCEL_ENV=%s before parsing or extraction', async (vercel) => {
    setEnvironment('production', vercel);
    expect(isDurableVideoIntelligenceAvailable()).toBe(false);
    expect(() => assertDurableVideoIntelligenceAvailable()).toThrow('protected Vercel Preview');
    for (const status of [400, 409, 500]) expect(videoIntelligenceHttpStatus(status)).toBe(404);
    for (const route of [job, library, selection, preview]) expect((await route(malformed())).status).toBe(404);
    expect((await readJob(new Request('http://localhost/jobs'))).status).toBe(404);
    await expect(getApprovedPreparedSelectedTraVideoFrames(null as never, null as never, [], null as never)).rejects.toThrow('protected Vercel Preview');
  });

  it('lets Preview requests reach validation while legacy prototype routes remain denied', async () => {
    setEnvironment('production', 'preview');
    for (const route of [job, library, selection, preview]) expect((await route(malformed())).status).toBe(400);
    expect((await readJob(new Request('http://localhost/jobs'))).status).toBe(400);
    for (const route of [legacyAnalysis, legacySelection]) expect((await route(malformed())).status).toBe(404);
  });

  it.each(Object.keys(productionConfig).flatMap(name => [undefined, '', ' \t '].map(value => ({ name, value }))))
  ('rejects missing/blank $name configuration: $value', async ({ name, value }) => {
    configureProduction(); vi.stubEnv(name, value);
    expect(isDurableVideoIntelligenceAvailable()).toBe(false);
    expect(() => assertDurableVideoIntelligenceAvailable()).toThrow('configured Production');
    for (const route of [job, library, selection, preview]) {
      const input = { json: vi.fn() } as unknown as Request;
      expect((await route(input)).status).toBe(404); expect(input.json).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_fixture'], ['CLERK_SECRET_KEY', 'sk_test_fixture'],
    ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_live_'], ['CLERK_SECRET_KEY', 'sk_live_'],
  ])('rejects non-Production or incomplete Clerk markers: %s', (name, value) => {
    configureProduction(); vi.stubEnv(name, value);
    expect(isDurableVideoIntelligenceAvailable()).toBe(false);
  });

  it.each([undefined, '', 'development', 'staging', 'PRODUCTION'])('does not enable an unidentified production runtime: %s', (vercel) => {
    configureProduction(); vi.stubEnv('VERCEL_ENV', vercel);
    expect(isDurableVideoIntelligenceAvailable()).toBe(false);
  });

  it('enables configured Production while preserving validation and legacy denial', async () => {
    configureProduction();
    expect(isDurableVideoIntelligenceAvailable()).toBe(true);
    expect(() => assertDurableVideoIntelligenceAvailable()).not.toThrow();
    for (const status of [400, 409, 429, 500, 503]) expect(videoIntelligenceHttpStatus(status)).toBe(status);
    for (const route of [job, library, selection, preview]) expect((await route(malformed())).status).toBe(400);
    expect((await readJob(new Request('http://localhost/jobs'))).status).toBe(400);
    for (const route of [legacyAnalysis, legacySelection]) expect((await route(malformed())).status).toBe(404);
  });
});
