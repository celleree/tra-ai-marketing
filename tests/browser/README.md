Run the actual Create React tree with offline API fixtures in Chromium:

```sh
node tests/browser/video-review.mjs
```

Requires an installed Playwright package and Chromium. If they are outside this checkout, set `PLAYWRIGHT_MODULE_PATH` to its `index.mjs` and `PLAYWRIGHT_CHROMIUM_PATH` to the existing browser executable. The runner uses the repository's Vite and Next browser polyfills, launches an isolated localhost harness, intercepts every API request, and aborts external HTTPS traffic. It does not test Clerk, deployed R2, provider quality, or the final combined staging flow. No production dependencies or CI workflow changes are needed.
