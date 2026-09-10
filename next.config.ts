import type { NextConfig } from 'next';
import { parsePublishableKey } from '@clerk/shared/keys';

type HeaderEnvironment = {
  clerkPublishableKey?: string;
  nodeEnv?: string;
  vercelEnv?: string;
};

const cspValue = (directives: Record<string, string[]>) =>
  Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');

export function getClerkFrontendApiOrigin(publishableKey?: string) {
  const frontendApi = parsePublishableKey(publishableKey)?.frontendApi;
  if (!frontendApi) return '';

  try {
    const url = new URL(`https://${frontendApi}`);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.pathname === '/'
      ? url.origin
      : '';
  } catch {
    return '';
  }
}

export function buildContentSecurityPolicy({
  clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  nodeEnv = process.env.NODE_ENV,
  vercelEnv = process.env.VERCEL_ENV,
}: HeaderEnvironment = {}) {
  const clerkFrontendApi = getClerkFrontendApiOrigin(clerkPublishableKey);
  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    ...(nodeEnv === 'production' ? [] : ["'unsafe-eval'"]),
    ...(clerkFrontendApi ? [clerkFrontendApi] : []),
    'https://challenges.cloudflare.com',
    'https://*.protect.clerk.com',
  ];
  const connectSources = [
    "'self'",
    ...(clerkFrontendApi ? [clerkFrontendApi] : []),
    'https://clerk-telemetry.com',
    'https://*.clerk-telemetry.com',
    'https://img.clerk.com',
    'https://*.protect.clerk.com:*',
    'https://*.r2.cloudflarestorage.com',
  ];
  const preview = vercelEnv === 'preview';

  if (preview) {
    scriptSources.push('https://vercel.live');
    connectSources.push('https://vercel.live', 'wss://ws-us3.pusher.com');
  }

  return cspValue({
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'script-src': scriptSources,
    'connect-src': connectSources,
    'img-src': ["'self'", 'data:', 'blob:', 'https:', ...(preview ? ['https://vercel.live', 'https://vercel.com'] : [])],
    'worker-src': ["'self'", 'blob:'],
    'style-src': ["'self'", "'unsafe-inline'", ...(preview ? ['https://vercel.live'] : [])],
    'font-src': ["'self'", 'data:', ...(preview ? ['https://vercel.live', 'https://assets.vercel.com'] : [])],
    'media-src': ["'self'", 'blob:'],
    'frame-src': ["'self'", 'https://challenges.cloudflare.com', 'https://*.protect.clerk.com', ...(preview ? ['https://vercel.live'] : [])],
  });
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: buildContentSecurityPolicy() },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Permissions-Policy', value: 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()' },
      ],
    }];
  },
  outputFileTracingIncludes: {
    '/api/video/intelligence/jobs': ['./.runtime/ffmpeg/**/*'],
    '/api/video/intelligence/selected-frame-preview': ['./.runtime/ffmpeg/**/*'],
    '/api/creatives/generate': ['./.runtime/ffmpeg/**/*', './assets/tax-documents/*.jpg'],
    '/api/creatives/*/revise': ['./.runtime/ffmpeg/**/*', './assets/tax-documents/*.jpg'],
  },
};

export default nextConfig;
