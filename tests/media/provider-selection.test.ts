import { afterEach, describe, expect, it, vi } from 'vitest';

const R2_ENV = {
  R2_ACCOUNT_ID: 'account-id',
  R2_ACCESS_KEY_ID: 'access-key-id',
  R2_SECRET_ACCESS_KEY: 'secret-access-key',
  R2_BUCKET_NAME: 'bucket-name',
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('media storage provider selection', () => {
  it('uses local storage outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    for (const name of Object.keys(R2_ENV)) {
      vi.stubEnv(name, '');
    }

    const { getMediaStorage, LocalMediaStorage } = await import(
      '@/lib/media/local-storage'
    );

    expect(getMediaStorage()).toBeInstanceOf(LocalMediaStorage);
  });

  it.each(Object.keys(R2_ENV))(
    'fails closed in production when %s is missing',
    async (missingName) => {
      vi.stubEnv('NODE_ENV', 'production');
      for (const [name, value] of Object.entries(R2_ENV)) {
        vi.stubEnv(name, name === missingName ? '' : value);
      }

      const { getMediaStorage } = await import('@/lib/media/local-storage');

      expect(() => getMediaStorage()).toThrow(new RegExp(missingName));
    }
  );

  it('selects R2 when production configuration is complete', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const [name, value] of Object.entries(R2_ENV)) {
      vi.stubEnv(name, value);
    }

    const { getMediaStorage, LocalMediaStorage } = await import(
      '@/lib/media/local-storage'
    );
    const { R2MediaStorage } = await import('@/lib/media/r2-storage');
    const storage = getMediaStorage();

    expect(storage).toBeInstanceOf(R2MediaStorage);
    expect(storage).not.toBeInstanceOf(LocalMediaStorage);
  });
});
