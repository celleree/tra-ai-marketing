import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOperatorAccess: vi.fn(), available: vi.fn(), execute: vi.fn(), read: vi.fn(),
  resolve: vi.fn(), load: vi.fn(), select: vi.fn(),
}));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: mocks.getOperatorAccess }));
vi.mock('@/lib/video/preview-availability', async (load) => ({
  ...await load<typeof import('@/lib/video/preview-availability')>(),
  assertDurableVideoIntelligenceAvailable: mocks.available,
}));
vi.mock('@/lib/video/intelligence-service', async (load) => ({
  ...await load<typeof import('@/lib/video/intelligence-service')>(),
  executeVideoIntelligenceStep: mocks.execute,
  readVideoIntelligenceSource: mocks.read,
  resolveExistingVideoIntelligenceJob: mocks.resolve,
}));
vi.mock('@/lib/video/intelligence-finalization-runner', async (load) => ({
  ...await load<typeof import('@/lib/video/intelligence-finalization-runner')>(),
  loadVideoIntelligenceLibrary: mocks.load,
}));
vi.mock('@/lib/video/selection-cache', () => ({ selectVideoFramesWithCache: mocks.select }));

import { GET as readJob, POST as job } from '@/app/api/video/intelligence/jobs/route';
import { POST as library } from '@/app/api/video/intelligence/library/route';
import { POST as selection } from '@/app/api/video/intelligence/selection/route';

const deniedRequest = { json: vi.fn() } as unknown as Request;
const guardedRoutes = [
  ['jobs GET', () => readJob(deniedRequest)],
  ['jobs POST', () => job(deniedRequest)],
  ['library POST', () => library(deniedRequest)],
  ['selection POST', () => selection(deniedRequest)],
] as const;

describe('durable video operator guards', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([401, 403, 503].flatMap((status) =>
    guardedRoutes.map(([route, invoke]) => [status, route, invoke] as const)
  ))('returns %i from %s before parsing or service work', async (status, _route, invoke) => {
    mocks.getOperatorAccess.mockResolvedValue({
      allowed: false,
      status,
      error: 'Access denied.',
    });

    const response = await invoke();

    expect(response.status).toBe(status);
    expect(mocks.getOperatorAccess).toHaveBeenCalledTimes(1);
    expect(deniedRequest.json).not.toHaveBeenCalled();
    expect(mocks.available).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
