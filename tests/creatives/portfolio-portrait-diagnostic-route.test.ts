import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ access: vi.fn(), read: vi.fn(), diagnostic: vi.fn() }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.access }));
vi.mock('@/lib/creatives/portfolio-job-storage', () => ({ readCreativePortfolio: mocks.read }));
vi.mock('@/lib/creatives/portfolio-portrait-diagnostic', () => ({ portfolioPortraitDiagnostic: mocks.diagnostic }));
import * as route from '@/app/api/creatives/portfolios/portrait-diagnostic/route';
const id = `portfolio_${'a'.repeat(32)}`, request = () => new Request(`https://preview.test/api/creatives/portfolios/portrait-diagnostic?id=${id}&slotIndex=2`);
beforeEach(() => { vi.clearAllMocks(); mocks.access.mockResolvedValue({ allowed: true }); mocks.read.mockResolvedValue({ id }); mocks.diagnostic.mockResolvedValue({ png: null, failedChecks: ['eyes'] }); });
it('uses authenticated GET only and returns private uncached diagnostics', async () => {
  const response = await route.GET(request()); expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(mocks.diagnostic).toHaveBeenCalledWith({ id }, 2); expect(route).not.toHaveProperty('POST'); expect(route).not.toHaveProperty('PATCH');
});
it.each([401, 403])('denies %s before reading any portfolio or assessment', async status => {
  mocks.access.mockResolvedValue({ allowed: false, status, message: 'Sign in required.' });
  expect((await route.GET(request())).status).toBe(status); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.diagnostic).not.toHaveBeenCalled();
});
it('validates input and handles missing or unavailable paused portrait without mutation', async () => {
  expect((await route.GET(new Request('https://preview.test/?id=invalid&slotIndex=2'))).status).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled(); mocks.read.mockResolvedValueOnce(null);
  expect((await route.GET(request())).status).toBe(404); mocks.diagnostic.mockRejectedValueOnce(new Error('private detail'));
  const response = await route.GET(request()); expect(response.status).toBe(409); expect(await response.text()).not.toContain('private detail');
});
