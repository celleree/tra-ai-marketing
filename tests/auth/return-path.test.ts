import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { safeWorkspaceReturnPath, workspaceSignInUrl } from '@/lib/auth/return-path';

const { access, redirect } = vi.hoisted(() => ({ access: vi.fn(), redirect: vi.fn() }));
vi.mock('next/server', () => ({ connection: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('@clerk/nextjs', () => ({ UserButton: () => null, SignIn: ({ forceRedirectUrl }: { forceRedirectUrl: string }) =>
  createElement('div', { 'data-return-to': forceRedirectUrl }) }));
vi.mock('@/lib/auth/server-access', () => ({ getOperatorAccess: access, isClerkConfigured: () => true }));
vi.mock('@/components/creative-generator/creative-generator', () => ({ CreativeGenerator: () => null }));
import { OperatorWorkspace } from '@/components/auth/operator-workspace';
import HomePage from '@/app/page';
import SignInPage from '@/app/sign-in/[[...sign-in]]/page';

const saved = '/?portfolio=portfolio_' + 'a'.repeat(32) + '&review=review_' + 'b'.repeat(32);
describe('saved workspace sign-in return', () => {
  beforeEach(() => { vi.clearAllMocks(); redirect.mockImplementation((url: string) => { throw new Error(url); }); });
  it('preserves both saved identities through the page and signed-out boundary', async () => {
    const page = await HomePage({ searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(saved.slice(2)))) });
    expect(page.props.returnTo).toBe(saved);
    access.mockResolvedValue({ allowed: false, status: 401 });
    await expect(OperatorWorkspace({ children: null, returnTo: page.props.returnTo })).rejects.toThrow(workspaceSignInUrl(saved));
    expect(new URL(workspaceSignInUrl(saved), 'https://example.com').searchParams.get('redirect_url')).toBe(saved);
  });
  it.each(['https://outside.example/', '//outside.example/', '/\\outside.example/', '/sign-in?redirect_url=//outside.example', '/studio\n//outside.example'])
    ('rejects an unsafe sign-in return %s', async value => {
      expect(safeWorkspaceReturnPath(value)).toBe('/');
      const html = renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({ redirect_url: value }) }));
      expect(html).toContain('data-return-to="/"');
    });
  it('allows protected internal studio paths and the saved portfolio path', async () => {
    expect(safeWorkspaceReturnPath('/studio/video?mediaId=media_123')).toBe('/studio/video?mediaId=media_123');
    const html = renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({ redirect_url: saved }) }));
    expect(html).toContain('portfolio_' + 'a'.repeat(32)); expect(html).toContain('review_' + 'b'.repeat(32));
  });
  it('keeps signed-in permission denial intact', async () => {
    access.mockResolvedValue({ allowed: false, status: 403 });
    const html = renderToStaticMarkup(await OperatorWorkspace({ children: createElement('p', null, 'private'), returnTo: saved }));
    expect(html).toContain('Operator access required'); expect(html).not.toContain('private'); expect(redirect).not.toHaveBeenCalled();
  });
});
