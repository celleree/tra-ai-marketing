import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
const clerk = vi.hoisted(() => ({ auth: vi.fn(), client: vi.fn(), user: vi.fn() }));
vi.mock('@clerk/nextjs/server', () => ({ auth: clerk.auth, clerkClient: clerk.client }));
import { TRA_OPERATOR_EMAILS } from '@/lib/auth/operators';
import { getOperatorAccess } from '@/lib/auth/server-access';
import { isDeploymentRuntimeConsistent } from '@/lib/runtime/deployment';
import { getVideoIntelligenceStorage, LocalVideoIntelligenceStorage, R2VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { assertLocalVideoIntelligence, loadVideoFrameLibrary } from '@/lib/video/library-service';
import { OperatorQuotaUnavailableError, reserveOperatorQuota } from '@/lib/quotas/operator-quota';
import { requireOperatorQuota } from '@/lib/quotas/require-quota';
import { GET as legacyRead, POST as legacyAnalyze } from '@/app/api/video/intelligence/route';
import { POST as legacySelect } from '@/app/api/video/selection/route';

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  for (const [name, value] of Object.entries({
    NODE_ENV: 'production', VERCEL_ENV: 'production',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_fixture', CLERK_SECRET_KEY: 'sk_live_fixture',
    OPENAI_API_KEY: 'fixture-provider', R2_ACCOUNT_ID: 'fixture-account', R2_ACCESS_KEY_ID: 'fixture-access',
    R2_SECRET_ACCESS_KEY: 'fixture-secret', R2_BUCKET_NAME: 'fixture-bucket',
  })) vi.stubEnv(name, value);
  clerk.auth.mockResolvedValue({ userId: 'operator' });
  clerk.client.mockResolvedValue({ users: { getUser: clerk.user } });
  clerk.user.mockResolvedValue({ primaryEmailAddressId: 'email', emailAddresses: [
    { id: 'email', emailAddress: TRA_OPERATOR_EMAILS[0], verification: { status: 'verified' } },
  ] });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network call'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('actual deployment auth, storage, quota and legacy boundaries', () => {
  it.each(['production', 'preview'].flatMap(vercel => ['development', 'test', '', undefined].map(node => ({ vercel, node }))))
  ('fails closed for configured $vercel with NODE_ENV=$node', async ({ vercel, node }) => {
    vi.stubEnv('VERCEL_ENV', vercel); vi.stubEnv('NODE_ENV', node);
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(() => { throw new Error('Unexpected R2 call'); });
    const read = vi.spyOn(LocalVideoIntelligenceStorage.prototype, 'read').mockRejectedValue(new Error('Unexpected local read'));
    const write = vi.spyOn(LocalVideoIntelligenceStorage.prototype, 'write').mockRejectedValue(new Error('Unexpected local write'));
    const { getMediaStorage } = await import('@/lib/media/local-storage');
    expect(isDeploymentRuntimeConsistent()).toBe(false);
    expect(() => getMediaStorage()).toThrow('NODE_ENV=production');
    expect(() => getVideoIntelligenceStorage()).toThrow('NODE_ENV=production');
    expect(() => assertLocalVideoIntelligence()).toThrow('NODE_ENV=production');
    await expect(loadVideoFrameLibrary(`media_${'a'.repeat(32)}`, 'b'.repeat(64))).rejects.toThrow('NODE_ENV=production');
    // No injected storage or mocked auth/quota adapter: exercise the real fallback selectors.
    await expect(reserveOperatorQuota({ operatorId: 'operator', group: 'VIDEO_PREPARATION', units: 1 }))
      .rejects.toBeInstanceOf(OperatorQuotaUnavailableError);
    const denied = await requireOperatorQuota('operator', 'VIDEO_PREPARATION', 1);
    expect(denied?.status).toBe(503);
    expect(denied?.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(getOperatorAccess()).resolves.toMatchObject({ allowed: false, status: 503 });
    for (const route of [legacyRead, legacyAnalyze, legacySelect]) {
      const json = vi.fn(), url = vi.fn(() => 'http://localhost/api/video');
      const input = { json, get url() { return url(); } } as unknown as Request;
      expect((await route(input)).status).toBe(503);
      expect(json).not.toHaveBeenCalled(); expect(url).not.toHaveBeenCalled();
    }
    for (const mock of [clerk.auth, clerk.client, clerk.user, send, read, write, fetch]) expect(mock).not.toHaveBeenCalled();
  });

  it.each(['production', 'preview'])('rejects a cached local media adapter after conflicting %s settings', async vercel => {
    vi.stubEnv('VERCEL_ENV', 'development'); vi.stubEnv('NODE_ENV', 'test');
    const { getMediaStorage, LocalMediaStorage } = await import('@/lib/media/local-storage');
    expect(getMediaStorage()).toBeInstanceOf(LocalMediaStorage);
    vi.stubEnv('VERCEL_ENV', vercel);
    expect(() => getMediaStorage()).toThrow('NODE_ENV=production');
  });

  it.each(['production', 'preview'])('retains R2 and approved operator access in consistent %s', async vercel => {
    vi.stubEnv('VERCEL_ENV', vercel);
    const { getMediaStorage } = await import('@/lib/media/local-storage');
    const { R2MediaStorage } = await import('@/lib/media/r2-storage');
    expect(isDeploymentRuntimeConsistent()).toBe(true);
    expect(getMediaStorage()).toBeInstanceOf(R2MediaStorage);
    expect(getVideoIntelligenceStorage()).toBeInstanceOf(R2VideoIntelligenceStorage);
    await expect(getOperatorAccess()).resolves.toEqual({ allowed: true, userId: 'operator' });
    expect(() => assertLocalVideoIntelligence()).toThrow('local development only');
  });

  it.each(['development', 'test'])('retains local storage only in actual local %s', async node => {
    vi.stubEnv('VERCEL_ENV', 'development'); vi.stubEnv('NODE_ENV', node);
    const { getMediaStorage, LocalMediaStorage } = await import('@/lib/media/local-storage');
    expect(isDeploymentRuntimeConsistent()).toBe(true);
    expect(getMediaStorage()).toBeInstanceOf(LocalMediaStorage);
    expect(getVideoIntelligenceStorage()).toBeInstanceOf(LocalVideoIntelligenceStorage);
    expect(() => assertLocalVideoIntelligence()).not.toThrow();
  });
});
