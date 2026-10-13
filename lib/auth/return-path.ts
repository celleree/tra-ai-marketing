/** Sign-in may return only to this application's protected workspace routes. */
export function safeWorkspaceReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
    || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    const url = new URL(value, 'https://workspace.invalid');
    if (url.origin !== 'https://workspace.invalid'
      || (url.pathname !== '/' && url.pathname !== '/studio' && !url.pathname.startsWith('/studio/'))) return '/';
    return url.pathname + url.search;
  } catch { return '/'; }
}

export const workspaceSignInUrl = (returnTo: unknown) =>
  '/sign-in?redirect_url=' + encodeURIComponent(safeWorkspaceReturnPath(returnTo));
