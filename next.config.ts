import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    '/api/video/intelligence/jobs': ['./.runtime/ffmpeg/**/*'],
    '/api/creatives/generate': ['./.runtime/ffmpeg/**/*'],
    '/api/creatives/*/revise': ['./.runtime/ffmpeg/**/*'],
  },
};

export default nextConfig;
