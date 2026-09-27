import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageRenderPurpose, prepareImageRenderRequest } from '@/lib/creatives/image-render-request';
import { fetchCreativeImage, runCreativeImageModelRoute, creativeImageHttpError } from '@/lib/creatives/image-models';

const url = 'https://api.openai.com/v1/images/generations';
const parameters = { model: 'gpt-image-2.5-sunburst', prompt: 'Exact\n prompt  ', size: '1024x1024', quality: 'auto' };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('image render profiles', () => {
  it.each(['production', 'staging-smoke', 'diagnostic'] as const)('sets explicit %s JSON options', purpose => {
    const result = prepareImageRenderRequest(url, { method: 'POST', body: JSON.stringify(parameters) }, purpose);
    expect(JSON.parse(result.body as string)).toEqual({ ...parameters,
      quality: purpose === 'diagnostic' ? 'low' : 'high', n: 1, output_format: 'png', stream: false, partial_images: 0 });
  });
  it('preserves ordered multipart attachments and the caller body', async () => {
    const form = new FormData();
    for (const [key, value] of Object.entries(parameters)) form.set(key, value);
    form.append('image[]', new Blob(['first']), 'approved.png');
    form.append('image[]', new Blob(['second']), 'document.png');
    const result = prepareImageRenderRequest(url.replace('generations', 'edits'), { method: 'POST', body: form }, 'diagnostic');
    const body = result.body as FormData;
    expect(body.get('prompt')).toBe(parameters.prompt);
    expect(body.get('quality')).toBe('low');
    expect(body.get('n')).toBe('1');
    expect(body.get('stream')).toBe('false');
    expect(body.get('partial_images')).toBe('0');
    expect(await Promise.all(body.getAll('image[]').map(file => (file as File).text()))).toEqual(['first', 'second']);
    expect(body.getAll('image[]').map(file => (file as File).name)).toEqual(['approved.png', 'document.png']);
    expect(form.get('quality')).toBe('auto');
  });
  it('defaults to LOW outside deployed production and HIGH in production', () => {
    vi.stubEnv('TRA_IMAGE_PURPOSE', ''); vi.stubEnv('VERCEL_ENV', 'preview'); vi.stubEnv('NODE_ENV', 'production');
    expect(imageRenderPurpose()).toBe('diagnostic');
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(imageRenderPurpose()).toBe('production');
    vi.stubEnv('TRA_IMAGE_PURPOSE', 'unexpected');
    expect(imageRenderPurpose).toThrow('TRA_IMAGE_PURPOSE');
  });
  it.each(['1024x1024', '1024x1280', '1152x2048'])('preserves placement %s', size => {
    const result = prepareImageRenderRequest(url, { method: 'POST', body: JSON.stringify({ ...parameters, size }) }, 'production');
    expect(JSON.parse(result.body as string).size).toBe(size);
  });
  it('rejects automatic dimensions and a diagnostic alternate model before dispatch', async () => {
    vi.stubEnv('TRA_IMAGE_PURPOSE', 'diagnostic');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const override of [{ size: 'auto' }, { model: 'gpt-image-2.5-flare' }]) {
      await expect(fetchCreativeImage(url, { method: 'POST', body: JSON.stringify({ ...parameters, ...override }) })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('makes one LOW request and no fallback after a diagnostic provider failure', async () => {
    vi.stubEnv('TRA_IMAGE_PURPOSE', 'diagnostic');
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 })); vi.stubGlobal('fetch', fetch);
    await expect(runCreativeImageModelRoute({ operationType: 'PROMPT_GENERATION', generate: async model => {
      await fetchCreativeImage(url, { method: 'POST', body: JSON.stringify({ ...parameters, model }) });
      throw creativeImageHttpError(503, 'unavailable');
    } })).rejects.toThrow('HTTP 503');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ quality: 'low', n: 1, partial_images: 0 });
  });
});
