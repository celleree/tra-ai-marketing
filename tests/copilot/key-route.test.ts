vi.mock('server-only', () => ({}));
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ access: vi.fn(), ready: vi.fn(), status: vi.fn(), change: vi.fn() }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.access }));
vi.mock('@/lib/provider-secrets/anthropic', async original => ({ ...await original<typeof import('@/lib/provider-secrets/anthropic')>(), providerSecretsReady: mocks.ready, getProviderSecretStatus: mocks.status, changeAnthropicCredential: mocks.change }));
import { GET, POST, DELETE } from '@/app/api/copilot/key/route';
import { ProviderSecretError } from '@/lib/provider-secrets/anthropic';
const dummy = 'sk-ant-offline_dummy_0123456789';
const request = (body: unknown) => new Request('https://localhost/api/copilot/key', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks(); mocks.access.mockResolvedValue({ allowed: true, userId: 'clerk-operator' }); mocks.ready.mockReturnValue(true);
  mocks.status.mockResolvedValue({ configured: true, revision: 'revision', updatedAt: 'now' }); mocks.change.mockResolvedValue({ configured: true, revision: 'next', updatedAt: 'now' });
});
afterEach(() => vi.unstubAllEnvs());
describe('authenticated credential endpoints', () => {
  it.each([401, 403, 503])('gates all key operations before storage/body access: %i', async status => {
    mocks.access.mockResolvedValue({ allowed: false, status, error: 'Denied' });
    expect((await GET()).status).toBe(status); expect((await POST(request({}))).status).toBe(status); expect((await DELETE(request({}))).status).toBe(status);
    expect(mocks.status).not.toHaveBeenCalled(); expect(mocks.change).not.toHaveBeenCalled();
  });
  it('returns status only and uses server identity for set/rotate/remove', async () => {
    expect(await (await GET()).json()).toEqual({ ready: true, configured: true, revision: 'revision', updatedAt: 'now' });
    expect(mocks.status).toHaveBeenCalledWith('clerk-operator');
    const response = await POST(request({ apiKey: dummy, revision: null }));
    expect(response.headers.get('Cache-Control')).toBe('private, no-store'); expect(JSON.stringify(await response.json())).not.toContain(dummy);
    expect(mocks.change).toHaveBeenCalledWith('clerk-operator', dummy, null);
    await DELETE(request({ revision: 'revision' })); expect(mocks.change).toHaveBeenCalledWith('clerk-operator', null, 'revision');
  });
  it('rejects caller identity, malformed/oversized requests, and missing master key', async () => {
    expect((await POST(request({ apiKey: dummy, revision: null, userId: 'other' }))).status).toBe(400);
    expect((await POST(request({ apiKey: 'x'.repeat(5000), revision: null }))).status).toBe(400);
    mocks.ready.mockReturnValue(false); expect((await POST(request({ apiKey: dummy, revision: null }))).status).toBe(503);
    expect(await (await GET()).json()).toHaveProperty('ready', false); expect(mocks.change).not.toHaveBeenCalled();
  });
  it('redacts failures and reports revision conflicts', async () => {
    mocks.change.mockRejectedValueOnce(new Error(dummy)); expect(JSON.stringify(await (await POST(request({ apiKey: dummy, revision: null }))).json())).not.toContain(dummy);
    mocks.change.mockRejectedValueOnce(new ProviderSecretError('conflict')); expect((await DELETE(request({ revision: 'old' }))).status).toBe(409);
  });
  it('rejects acceptance-preview writes', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview'); vi.stubEnv('TRA_IMAGE_PURPOSE', 'staging-smoke');
    expect((await POST(request({ apiKey: dummy, revision: null }))).status).toBe(409); expect(mocks.change).not.toHaveBeenCalled();
  });
});
