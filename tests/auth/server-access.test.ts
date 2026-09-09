import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock, clientMock, getUserMock } = vi.hoisted(() => ({
  authMock: vi.fn(), clientMock: vi.fn(), getUserMock: vi.fn(),
}));
vi.mock('@clerk/nextjs/server', () => ({ auth: authMock, clerkClient: clientMock }));
import { getOperatorAccess } from '@/lib/auth/server-access';

describe('server operator access', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'test-publishable-key');
    vi.stubEnv('CLERK_SECRET_KEY', 'test-secret-key');
    authMock.mockResolvedValue({ userId: 'user_operator' });
    clientMock.mockResolvedValue({ users: { getUser: getUserMock } });
    getUserMock.mockResolvedValue({
      primaryEmailAddressId: 'primary',
      emailAddresses: [{ id: 'primary', emailAddress: 'arundel.kramer@tra.com', verification: { status: 'verified' } }],
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('authorizes a session using the current server-verified Clerk user', async () => {
    await expect(getOperatorAccess()).resolves.toEqual({ allowed: true, userId: 'user_operator' });
    expect(authMock).toHaveBeenCalledWith({ acceptsToken: 'session_token' });
    expect(getUserMock).toHaveBeenCalledWith('user_operator');
  });

  it.each(['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'])(
    'fails closed before invoking Clerk when %s is missing', async (name) => {
      vi.stubEnv(name, '  ');
      await expect(getOperatorAccess()).resolves.toMatchObject({ allowed: false, status: 503 });
      expect(authMock).not.toHaveBeenCalled();
      expect(clientMock).not.toHaveBeenCalled();
    },
  );

  it('denies signed-out requests without fetching a user', async () => {
    authMock.mockResolvedValue({ userId: null });
    await expect(getOperatorAccess()).resolves.toMatchObject({ allowed: false, status: 401 });
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it.each([
    ['other@tra.com', 'verified'],
    ['arundel.kramer@tra.com', 'unverified'],
  ])('denies unauthorized identity %s (%s)', async (emailAddress, status) => {
    getUserMock.mockResolvedValue({
      primaryEmailAddressId: 'primary',
      emailAddresses: [{ id: 'primary', emailAddress, verification: { status } }],
    });
    await expect(getOperatorAccess()).resolves.toMatchObject({ allowed: false, status: 403 });
  });

  it.each(['session', 'client', 'user'])('fails closed on %s provider failure without exposing details', async (boundary) => {
    const mock = boundary === 'session' ? authMock : boundary === 'client' ? clientMock : getUserMock;
    mock.mockRejectedValue(new Error('private provider diagnostics'));
    await expect(getOperatorAccess()).resolves.toEqual({
      allowed: false, status: 503, error: 'Authentication is unavailable.',
    });
  });
});
