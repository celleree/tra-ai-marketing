import { vi } from 'vitest';

// Keep spies that call through to real fetch offline too. Explicit live tests
// must opt in; merely simulating production in a unit test is not permission.
const networkFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'api.openai.com' && url.pathname.startsWith('/v1/images/')
    && process.env.TRA_LIVE_IMAGE_AUTHORIZATION !== 'allow-paid-image-generation') {
    return Promise.reject(new Error('Image network dispatch is disabled in tests; mock fetch or explicitly authorize paid images.'));
  }
  return networkFetch(input, init);
};

// Existing adapter tests exercise request construction with mocked fetch. Do not
// set a suite-wide live authorization: an unmocked dispatch must use real policy.
vi.mock('@/lib/creatives/image-provider-admission', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/creatives/image-provider-admission')>();
  return {
    ...actual,
    assertLiveImageGenerationAllowed: () => {
      if (!vi.isMockFunction(globalThis.fetch)) actual.assertLiveImageGenerationAllowed();
    },
  };
});
