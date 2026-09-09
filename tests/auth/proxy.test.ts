import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { clerkMiddlewareMock, configuredHandler } = vi.hoisted(() => ({
  clerkMiddlewareMock: vi.fn(), configuredHandler: vi.fn(),
}));
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: clerkMiddlewareMock }));
import proxy from '@/proxy';

describe('Clerk proxy entry', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configuredHandler.mockResolvedValue(new Response('configured'));
    clerkMiddlewareMock.mockReturnValue(configuredHandler);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'])(
    'continues without constructing Clerk middleware when %s is absent', async (name) => {
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'test-publishable');
    vi.stubEnv('CLERK_SECRET_KEY', 'test-secret');
    vi.stubEnv(name, '  ');
    expect(proxy(new Request('https://tra.test/studio') as never, {} as never)).toMatchObject({ status: 200 });
    expect(clerkMiddlewareMock).not.toHaveBeenCalled();
  });

  it('constructs and invokes Clerk middleware only after both keys are configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'test-publishable');
    vi.stubEnv('CLERK_SECRET_KEY', 'test-secret');
    const request = new Request('https://tra.test/studio');
    await expect(proxy(request as never, {} as never)).resolves.toMatchObject({ status: 200 });
    expect(clerkMiddlewareMock).toHaveBeenCalledOnce();
    expect(configuredHandler).toHaveBeenCalledWith(request, expect.anything());
  });
});
