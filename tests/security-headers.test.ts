import { describe, expect, it } from 'vitest';
import nextConfig, {
  buildContentSecurityPolicy,
  getClerkFrontendApiOrigin,
} from '@/next.config';

const customClerkKey = `pk_live_${Buffer.from('clerk.auth.tra.example$').toString('base64').replace(/=+$/, '')}`;

describe('browser security headers', () => {
  it('derives an exact HTTPS Clerk Frontend API origin from a valid publishable key', () => {
    expect(getClerkFrontendApiOrigin(customClerkKey)).toBe('https://clerk.auth.tra.example');
  });

  it('omits Clerk Frontend API origins for missing or invalid publishable keys', () => {
    expect(getClerkFrontendApiOrigin()).toBe('');
    expect(getClerkFrontendApiOrigin('pk_live_not-a-valid-key')).toBe('');
  });

  it('keeps the production policy narrow while allowing required Clerk, R2, and browser assets', () => {
    const policy = buildContentSecurityPolicy({ clerkPublishableKey: customClerkKey, nodeEnv: 'production' });

    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("script-src 'self' 'unsafe-inline' https://clerk.auth.tra.example");
    expect(policy).toContain('connect-src \'self\' https://clerk.auth.tra.example');
    expect(policy).toContain('https://*.r2.cloudflarestorage.com');
    expect(policy).toContain("img-src 'self' data: blob: https:");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain("media-src 'self' blob:");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toContain('script-src https:');
  });

  it('limits development eval and Vercel Toolbar origins to their respective environments', () => {
    const development = buildContentSecurityPolicy({ nodeEnv: 'development' });
    const preview = buildContentSecurityPolicy({ nodeEnv: 'production', vercelEnv: 'preview' });

    expect(development).toContain("'unsafe-eval'");
    expect(development).not.toContain('https://vercel.live');
    expect(preview).not.toContain("'unsafe-eval'");
    expect(preview).toContain('https://vercel.live');
    expect(preview).toContain('wss://ws-us3.pusher.com');
  });

  it('applies the policy and standard headers to every route', async () => {
    const headers = await nextConfig.headers?.();
    expect(headers).toHaveLength(1);
    expect(headers?.[0]?.source).toBe('/:path*');
    expect(headers?.[0]?.headers).toEqual(expect.arrayContaining([
      { key: 'Content-Security-Policy', value: expect.any(String) },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
    ]));
  });
});
