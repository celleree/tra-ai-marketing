import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  analyzeCompanyWebsite: vi.fn(),
  deleteBrandFont: vi.fn(),
  getMediaStorage: vi.fn(),
  getOperatorAccess: vi.fn(),
  readBrandFont: vi.fn(),
  readImageById: vi.fn(),
  saveBrandFont: vi.fn(),
}));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.getOperatorAccess }));
vi.mock('@/lib/company/font-storage', () => ({
  deleteBrandFont: mocks.deleteBrandFont,
  readBrandFont: mocks.readBrandFont,
  saveBrandFont: mocks.saveBrandFont,
}));
vi.mock('@/lib/company/website-analyzer', () => ({
  analyzeCompanyWebsite: mocks.analyzeCompanyWebsite,
}));
vi.mock('@/lib/media/local-storage', () => ({
  getMediaStorage: mocks.getMediaStorage,
}));

import { POST as analyzeWebsite } from '@/app/api/company/analyze-website/route';
import { POST as uploadFont } from '@/app/api/company/fonts/route';
import { DELETE as deleteFont, GET as readFont } from '@/app/api/company/fonts/[fileName]/route';
import { POST as analyzeFont } from '@/app/api/company/fonts/analyze/route';

const deniedRequest = { formData: vi.fn(), json: vi.fn() } as unknown as Request;
const context = () => {
  const params = vi.fn(() => Promise.resolve({ fileName: 'font_fixture.woff2' }));
  return { context: Object.defineProperty({}, 'params', { get: params }), params } as const;
};

const guardedRoutes = [
  ['website analysis', () => analyzeWebsite(deniedRequest), undefined],
  ['font upload', () => uploadFont(deniedRequest), undefined],
  ['font read', () => { const value = context(); return readFont(deniedRequest, value.context as { params: Promise<{ fileName: string }> }).then((response) => ({ response, params: value.params })); }, 'params'],
  ['font deletion', () => { const value = context(); return deleteFont(deniedRequest, value.context as { params: Promise<{ fileName: string }> }).then((response) => ({ response, params: value.params })); }, 'params'],
  ['font analysis', () => analyzeFont(deniedRequest), undefined],
] as const;

describe('company operator guards', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getMediaStorage.mockReturnValue({ readImageById: mocks.readImageById });
  });

  it.each([401, 403, 503].flatMap((status) =>
    guardedRoutes.map(([route, invoke, input]) => [status, route, invoke, input] as const)
  ))('returns %i from %s before accessing inputs or resources', async (status, _route, invoke, input) => {
    mocks.getOperatorAccess.mockResolvedValue({ allowed: false, status, error: 'Access denied.' });
    const result = await invoke();
    const response = result instanceof Response ? result : result.response;

    expect(response.status).toBe(status);
    expect(deniedRequest.formData).not.toHaveBeenCalled();
    expect(deniedRequest.json).not.toHaveBeenCalled();
    if (input === 'params' && !(result instanceof Response)) expect(result.params).not.toHaveBeenCalled();
    expect(mocks.analyzeCompanyWebsite).not.toHaveBeenCalled();
    expect(mocks.saveBrandFont).not.toHaveBeenCalled();
    expect(mocks.readBrandFont).not.toHaveBeenCalled();
    expect(mocks.deleteBrandFont).not.toHaveBeenCalled();
    expect(mocks.getMediaStorage).not.toHaveBeenCalled();
    expect(mocks.readImageById).not.toHaveBeenCalled();
  });
});
