import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_QUOTA_POLICY } from '@/lib/quotas/operator-quota';

const mocks = vi.hoisted(() => ({
  getOperatorAccess: vi.fn(), requireOperatorQuota: vi.fn(), getMediaStorage: vi.fn(),
  readImageById: vi.fn(), classifyReferenceCreativeAngle: vi.fn(), addToReferenceLibrary: vi.fn(),
}));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.getOperatorAccess }));
vi.mock('@/lib/quotas/require-quota', () => ({ requireOperatorQuota: mocks.requireOperatorQuota }));
vi.mock('@/lib/media/local-storage', () => ({ getMediaStorage: mocks.getMediaStorage }));
vi.mock('@/lib/ai/reference-angle', () => ({ classifyReferenceCreativeAngle: mocks.classifyReferenceCreativeAngle }));
vi.mock('@/lib/references/storage', () => ({ addToReferenceLibrary: mocks.addToReferenceLibrary }));

import { POST } from '@/app/api/references/route';

const items = (count: number) => Array.from({ length: count }, (_, i) => {
  const id = `media_${i.toString(16).padStart(32, '0')}`;
  return { id, fileName: `${id}.png`, originalName: 'reference.png', mimeType: 'image/png', size: 100 };
});
const request = (body: unknown) => new Request('http://localhost/api/references', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const expectNoWork = () => {
  expect(mocks.getMediaStorage).not.toHaveBeenCalled();
  expect(mocks.readImageById).not.toHaveBeenCalled();
  expect(mocks.classifyReferenceCreativeAngle).not.toHaveBeenCalled();
  expect(mocks.addToReferenceLibrary).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
};

describe('reference classification quota admission', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn());
    mocks.getOperatorAccess.mockResolvedValue({ allowed: true, userId: 'operator' });
    mocks.requireOperatorQuota.mockResolvedValue(null);
    mocks.getMediaStorage.mockReturnValue({ readImageById: mocks.readImageById });
    mocks.readImageById.mockResolvedValue({ buffer: Buffer.from('source'), mimeType: 'image/png' });
    mocks.classifyReferenceCreativeAngle.mockResolvedValue('customer-problems');
    mocks.addToReferenceLibrary.mockImplementation(async additions => additions);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it.each([401, 403, 503])('denies operator access before parsing or quota work: %i', async status => {
    mocks.getOperatorAccess.mockResolvedValue({ allowed: false, status, error: 'Denied' });
    const invalidJson = new Request('http://localhost/api/references', { method: 'POST', body: '{' });
    expect((await POST(invalidJson)).status).toBe(status);
    expect(mocks.requireOperatorQuota).not.toHaveBeenCalled();
    expectNoWork();
  });

  it.each([429, 503])('returns quota denial unchanged without classifying or saving fallback records: %i', async status => {
    const denial = new Response(null, { status, headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '60' } });
    mocks.requireOperatorQuota.mockResolvedValue(denial);
    const response = await POST(request({ items: items(2), referenceType: 'layout', userId: 'client-forgery' }));
    expect(response).toBe(denial);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(mocks.getOperatorAccess).toHaveBeenCalledTimes(1);
    expect(mocks.requireOperatorQuota).toHaveBeenCalledWith('operator', 'REFERENCE_CLASSIFICATION', 2);
    expectNoWork();
  });

  it('admits classification once per image before reading source pixels and preserves results', async () => {
    const response = await POST(request({ items: items(2) }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.map((item: { angleSource: string }) => item.angleSource)).toEqual(['ai', 'ai']);
    expect(mocks.requireOperatorQuota).toHaveBeenCalledTimes(1);
    expect(mocks.requireOperatorQuota).toHaveBeenCalledWith('operator', 'REFERENCE_CLASSIFICATION', 2);
    expect(mocks.requireOperatorQuota.mock.invocationCallOrder[0]).toBeLessThan(mocks.getMediaStorage.mock.invocationCallOrder[0]);
    expect(mocks.classifyReferenceCreativeAngle).toHaveBeenCalledTimes(2);
  });

  it('preserves the supported 100-image boundary instead of charging a whole batch as one unit', async () => {
    expect(OPERATOR_QUOTA_POLICY.REFERENCE_CLASSIFICATION).toBe(100);
    mocks.requireOperatorQuota.mockResolvedValue(new Response(null, { status: 429 }));
    expect((await POST(request({ items: items(100) }))).status).toBe(429);
    expect(mocks.requireOperatorQuota).toHaveBeenCalledWith('operator', 'REFERENCE_CLASSIFICATION', 100);
    expectNoWork();
  });

  it.each([{ items: [] }, { items: items(101) }, { items: [{ id: 'invalid' }] }])('rejects invalid or oversized inputs without reserving quota: %#', async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.requireOperatorQuota).not.toHaveBeenCalled();
    expectNoWork();
  });

  it.each(['tra', 'unconfigured'])('keeps non-provider reference registration outside the paid-classification quota: %s', async mode => {
    if (mode === 'unconfigured') vi.stubEnv('OPENAI_API_KEY', '');
    const response = await POST(request({ items: items(1), referenceType: mode === 'tra' ? 'tra' : 'layout' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items[0].angleSource).toBe(mode === 'tra' ? 'manual' : 'fallback');
    expect(mocks.requireOperatorQuota).not.toHaveBeenCalled();
    expect(mocks.classifyReferenceCreativeAngle).not.toHaveBeenCalled();
    expect(mocks.readImageById).not.toHaveBeenCalled();
    expect(mocks.addToReferenceLibrary).toHaveBeenCalledTimes(1);
  });
});
