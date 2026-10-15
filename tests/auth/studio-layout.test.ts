import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { accessMock, redirectMock } = vi.hoisted(() => ({ accessMock: vi.fn(), redirectMock: vi.fn() }));
vi.mock('next/server', () => ({ connection: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@clerk/nextjs', () => ({ UserButton: () => createElement('button', null, 'Account') }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: accessMock }));
import StudioLayout from '@/app/studio/layout';

const studioContent = () => createElement('p', null, 'Studio content');

describe('studio layout session entry', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    redirectMock.mockImplementation((path: string) => { throw new Error(`NEXT_REDIRECT:${path}`); });
  });

  it('renders studio children and a normal account control for an allowed operator', async () => {
    accessMock.mockResolvedValue({ allowed: true, userId: 'operator' });
    const view = await StudioLayout({ children: studioContent() });
    const html = renderToStaticMarkup(view);
    expect(html).toContain('Studio content');
    expect(html).toContain('Account');
    expect(html).not.toContain('class="studio-account"');
  });

  it('redirects signed-out visitors to sign-in', async () => {
    accessMock.mockResolvedValue({ allowed: false, status: 401, error: 'Sign in required.' });
    await expect(StudioLayout({ children: studioContent() })).rejects.toThrow('NEXT_REDIRECT:/sign-in');
    expect(redirectMock).toHaveBeenCalledWith('/sign-in');
  });

  it('does not render studio children for a signed-in non-operator', async () => {
    accessMock.mockResolvedValue({ allowed: false, status: 403, error: 'Operator access required.' });
    const html = renderToStaticMarkup(await StudioLayout({ children: studioContent() }));
    expect(html).toContain('Operator access required');
    expect(html).toContain('Account');
    expect(html).not.toContain('class="studio-account"');
    expect(html).not.toContain('Studio content');
  });

  it('does not render studio children when Clerk is unavailable', async () => {
    accessMock.mockResolvedValue({ allowed: false, status: 503, error: 'Authentication is unavailable.' });
    const html = renderToStaticMarkup(await StudioLayout({ children: studioContent() }));
    expect(html).toContain('Authentication is unavailable');
    expect(html).not.toContain('Studio content');
  });
});
