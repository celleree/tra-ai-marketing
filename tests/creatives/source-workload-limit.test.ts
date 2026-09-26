import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import { getCreativeSourceCountError, MAX_CREATIVE_SOURCE_ASSETS } from '@/lib/media/source-limits';
import { CREATIVE_SOURCE_ROLES } from '@/lib/media/types';

const mocks = vi.hoisted(() => ({
  getOperatorAccess: vi.fn(), getMediaStorage: vi.fn(), requireOperatorQuota: vi.fn(),
}));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.getOperatorAccess }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: mocks.getMediaStorage }));
vi.mock('@/lib/quotas/require-quota', () => ({ requireOperatorQuota: mocks.requireOperatorQuota }));

import { POST } from '@/app/api/creatives/generate/route';

const base = { context: 'Explain the approved TRA consultation.', variationCount: 2 };
const sources = (count: number) => Array.from({ length: count }, (_, index) => ({
  mediaId: `media_${index.toString(16).padStart(32, '0')}`,
  role: CREATIVE_SOURCE_ROLES[index % CREATIVE_SOURCE_ROLES.length],
}));
const request = (sourceAssets: unknown) => new Request('http://localhost/api/creatives/generate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...base, sourceAssets }),
});

describe('creative source workload limit', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn());
    mocks.getOperatorAccess.mockResolvedValue({ allowed: true, userId: 'operator' });
    mocks.requireOperatorQuota.mockResolvedValue(new Response(null, { status: 429 }));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('pins the shared policy and preserves the exact boundary with repeated roles', () => {
    expect(MAX_CREATIVE_SOURCE_ASSETS).toBe(10);
    const sourceAssets = sources(MAX_CREATIVE_SOURCE_ASSETS);
    const result = validateGenerateCreativeRequest({
      ...base, sourceAssets, brandLogoMediaId: `media_${'f'.repeat(32)}`,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.sourceAssets).toEqual(sourceAssets);
    expect(getCreativeSourceCountError(9 + 1)).toBe('');
    expect(getCreativeSourceCountError(9 + 2)).not.toBe('');
  });

  it('keeps text-only requests supported', () => {
    expect(validateGenerateCreativeRequest(base).success).toBe(true);
    expect(validateGenerateCreativeRequest({ ...base, sourceAssets: [] }).success).toBe(true);
  });

  it('rejects excess entries before inspecting individual source objects', () => {
    expect(validateGenerateCreativeRequest({
      ...base, sourceAssets: Array(MAX_CREATIVE_SOURCE_ASSETS + 1).fill(null),
    })).toEqual({ success: false, error: getCreativeSourceCountError(MAX_CREATIVE_SOURCE_ASSETS + 1) });
  });

  it.each([null, {}, 'invalid'])('rejects malformed collections: %j', async sourceAssets => {
    expect((await POST(request(sourceAssets))).status).toBe(400);
    expect(mocks.requireOperatorQuota).not.toHaveBeenCalled();
    expect(mocks.getMediaStorage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects the first excess source before quota reservation, hydration or providers', async () => {
    const response = await POST(request(sources(MAX_CREATIVE_SOURCE_ASSETS + 1)));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: getCreativeSourceCountError(MAX_CREATIVE_SOURCE_ASSETS + 1) });
    expect(mocks.requireOperatorQuota).not.toHaveBeenCalled();
    expect(mocks.getMediaStorage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('admits the exact boundary to local hydration without live provider work', async () => {
    mocks.getMediaStorage.mockReturnValue({ readMediaById: vi.fn().mockResolvedValue(null) });
    expect((await POST(request(sources(MAX_CREATIVE_SOURCE_ASSETS)))).status).toBe(404);
    expect(mocks.requireOperatorQuota).not.toHaveBeenCalled();
    expect(mocks.getMediaStorage).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still validates individual sources within the limit', async () => {
    expect((await POST(request([{ mediaId: 'invalid', role: 'TRA_REFERENCE' }]))).status).toBe(400);
    expect(mocks.requireOperatorQuota).not.toHaveBeenCalled();
    expect(mocks.getMediaStorage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
