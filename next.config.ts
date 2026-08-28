import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    '/api/creatives/generate': ['./.runtime/ffmpeg/**/*'],
  },
};

export default nextConfig;
