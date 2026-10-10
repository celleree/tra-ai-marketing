# Offline Create regression

Run the actual Create React tree with offline API fixtures in Chromium:

```sh
npm ci
npx --no-install playwright install chromium
npm run test:browser
```

Playwright and Vite are exact test-only dependencies in the lockfile. CI installs
the matching Chromium and Linux system dependencies with
`npx --no-install playwright install --with-deps chromium`, then runs this suite
inside the existing required `verify` job. No credentials or provider calls are
needed. The runner starts an isolated localhost harness, intercepts API requests
and aborts external HTTPS traffic.

`PLAYWRIGHT_MODULE_PATH` and `PLAYWRIGHT_CHROMIUM_PATH` remain optional diagnostic
overrides for existing local installations; CI uses the pinned defaults.

## Separate acceptance evidence

These fixtures prove UI state transitions, saved-review handling and request
payloads. They do not prove Clerk authentication, real upload/storage persistence,
provider quality, deployed R2 or the final combined staging flow. For changes at
those boundaries, separately record the tested deployed commit, environment,
real upload/save/reload result and any unmet acceptance criterion. Use authorized
test assets/accounts and approved provider activity. UI changes affecting touch,
layout or browser behavior also need proportional phone/WebKit evidence;
emulation does not establish physical-device behavior.
