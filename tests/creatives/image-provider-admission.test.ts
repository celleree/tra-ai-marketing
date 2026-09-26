import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCreativeImage, runCreativeImageModelRoute } from '@/lib/creatives/image-models';

// Exercise the real guard even though our dispatch is a mock.
vi.unmock('@/lib/creatives/image-provider-admission');

const endpoint = 'https://api.openai.com/v1/images/generations';
const key = 'sk-proj-fixture-not-a-real-credential';
const authorization = 'allow-paid-image-generation';
const offlineFetch = globalThis.fetch;
const dispatch = vi.fn();
const request = () => fetchCreativeImage(endpoint, {
  method: 'POST', headers: { Authorization: `Bearer ${key}` },
});

beforeEach(() => {
  for (const name of ['CI', 'VITEST', 'VERCEL_ENV', 'TRA_LIVE_IMAGE_AUTHORIZATION']) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('OPENAI_API_KEY', key);
  dispatch.mockReset().mockResolvedValue(Response.json({ data: [] }));
  vi.stubGlobal('fetch', dispatch);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('live image provider admission', () => {
  it.each(['test', 'development', 'production', undefined])(
    'denies ambient credentials in local NODE_ENV=%s', async nodeEnv => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      await expect(request()).rejects.toThrow('Live image generation is disabled');
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(['CI', 'VITEST'])('requires explicit authorization in %s even with production markers', async marker => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv(marker, 'true');
    await expect(request()).rejects.toThrow('TRA_LIVE_IMAGE_AUTHORIZATION');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('denies Preview without opt-in', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', 'preview');
    await expect(request()).rejects.toThrow('disabled');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(['test', 'development', 'production'])('recognizes intentional server authorization in %s', async nodeEnv => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('CI', 'true');
    vi.stubEnv('TRA_LIVE_IMAGE_AUTHORIZATION', authorization);
    await request();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` },
    });
  });

  it('preserves deployed production without a test-only opt-in', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', 'production');
    await request();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['1', 'true', 'ALLOW-PAID-IMAGE-GENERATION', ` ${authorization}`, key])(
    'fails closed for invalid authorization without echoing it', async value => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('VERCEL_ENV', 'production');
      vi.stubEnv('TRA_LIVE_IMAGE_AUTHORIZATION', value);
      const failure = await request().then(() => undefined, error => error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).toContain('TRA_LIVE_IMAGE_AUTHORIZATION=allow-paid-image-generation');
      expect(failure?.message).not.toContain(key);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it('does not let opt-in override inconsistent deployed runtime configuration', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('TRA_LIVE_IMAGE_AUTHORIZATION', authorization);
    await expect(request()).rejects.toThrow('disabled');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('never retries or falls back after a local admission denial', async () => {
    const generate = vi.fn(request);
    await expect(runCreativeImageModelRoute({ operationType: 'EDIT', generate })).rejects.toThrow('disabled');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps a pass-through fetch spy offline even when a test simulates production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubGlobal('fetch', vi.fn(offlineFetch));
    await expect(request()).rejects.toThrow('Image network dispatch is disabled in tests');
  });
});
