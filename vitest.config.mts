import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup/image-provider.ts'],
    // Preserve final-render fixtures without granting live provider admission.
    env: { TRA_IMAGE_PURPOSE: 'production' },
    include: ['tests/**/*.test.ts'],
  },
});
