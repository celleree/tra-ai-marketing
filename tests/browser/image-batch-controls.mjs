import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Default to the lockfile-pinned test dependency; optional overrides are diagnostic only.
const browserTypes = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browserName = process.env.VIDEO_REVIEW_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({ root, configFile: false, cacheDir: join(tmpdir(), 'tra-image-controls-vite'),
  plugins: [{ name: 'app-styles', transformIndexHtml: () => [
    { tag: 'meta', attrs: { name: 'viewport', content: 'width=device-width, initial-scale=1' }, injectTo: 'head' },
    ...['/app/globals.css', '/app/ui-sweep.css'].map(href => ({ tag: 'link', attrs: { rel: 'stylesheet', href }, injectTo: 'head' }))] }],
  resolve: { alias: { '@': root, 'node:crypto': root + 'node_modules/next/dist/compiled/crypto-browserify/index.js', ...Object.fromEntries(['buffer', 'events', 'stream', 'string_decoder', 'util', 'vm'].map(name => [name, require.resolve(root + 'node_modules/next/dist/compiled/' + ({ stream: 'stream-browserify', vm: 'vm-browserify' }[name] ?? name))])) } }, oxc: { jsx: { runtime: 'automatic' } },
  server: { host: '127.0.0.1', port: 0 }, define: { 'process.env': '{}', __dirname: JSON.stringify('/'), 'process.browser': 'true', global: 'globalThis' } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/video-review.html`;
const browser = await browserTypes[browserName].launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_PATH && browserName === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}) });

const savedId = `portfolio_${'4'.repeat(32)}`;
const results = [];
try {
  for (const width of [1440, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem('tra-company-profile-v2', JSON.stringify({ websiteUrl: '', knowledgeBase: {}, guardrails: {},
        brandGuidelines: { logo: '/api/media/files/media_77777777777777777777777777777777.png' } }));
    });
    const page = await context.newPage(); const errors = [], posts = [], commands = [];
    page.on('pageerror', error => errors.push(error.message));
    let saved = null;
    const failure = 'Use reference library is On, but no eligible layout references were selected. Add a reference or turn the control Off.';
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/creatives/portfolios') {
        const body = request.method() === 'GET' ? null : request.postDataJSON();
        if (request.method() === 'POST') {
          posts.push(body);
          saved = { id: savedId, requestedCount: body.variationCount, peoplePercent: body.peoplePercent, useReferenceLibrary: body.useReferenceLibrary,
            planReady: false, planningPhase: 'INITIAL_PLAN', planningCheckpoint: 1, planningError: failure, lease: null,
            slots: Array.from({ length: body.variationCount }, (_, i) => ({ index: i + 1, creativeId: `creative_${(i+1).toString().repeat(32)}`, status: 'PENDING' })) };
        } else if (body) commands.push(body);
        await route.fulfill({ status: 200, json: { job: saved, creatives: [], error: saved?.planningError } }); return;
      }
      if (path === '/api/references') { await route.fulfill({ json: { items: [] } }); return; }
      throw new Error(`Unexpected API request ${request.method()} ${path}`);
    });
    try {
      await page.goto(url); const count = page.getByRole('slider', { name: 'Number of creatives to generate' });
      const people = page.getByRole('slider', { name: 'Ads with people', exact: true });
      const toggle = page.getByRole('switch');
      await people.waitFor(); assert.equal(await people.inputValue(), '50'); assert.equal(await toggle.isChecked(), true);
      await page.getByText('2 with people · 2 without people', { exact: true }).waitFor();
      await count.focus(); await page.keyboard.press('ArrowRight');
      await page.getByText('3 with people · 2 without people', { exact: true }).waitFor();
      await people.focus(); await page.keyboard.press('Home');
      await page.getByText('0 with people · 5 without people', { exact: true }).waitFor();
      await page.keyboard.press('End'); await page.getByText('5 with people · 0 without people', { exact: true }).waitFor();
      await count.focus(); await page.keyboard.press('Home');
      await page.getByText('1 with people · 0 without people', { exact: true }).waitFor();
      await toggle.focus(); await page.keyboard.press('Space'); assert.equal(await toggle.isChecked(), false);
      await toggle.check();
      await page.locator('textarea').fill('Create a TRA consultation ad.');
      await page.getByRole('button', { name: 'Generate creatives', exact: true }).click();
      await page.getByText(failure, { exact: true }).first().waitFor();
      assert.equal(posts.length, 1); assert.equal(posts[0].variationCount, 1); assert.equal(posts[0].peoplePercent, 100); assert.equal(posts[0].useReferenceLibrary, true);
      assert.equal(commands.length, 0, 'failed selection must not auto-advance');
      await page.reload(); await page.waitForFunction(() => document.querySelector('#creative-people-slider')?.value === '100');
      assert.equal(await count.inputValue(), '1'); assert.equal(await toggle.isChecked(), true);
      await toggle.uncheck(); await people.focus(); await page.keyboard.press('Home');
      await page.getByRole('button', { name: 'Retry planning', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('#creative-people-slider')?.disabled);
      assert.deepEqual(commands, [{ id: savedId, action: 'retry', slotIndex: null }]);
      assert.equal(saved.peoplePercent, 100); assert.equal(saved.useReferenceLibrary, true);
      await page.locator('textarea').fill('Create another TRA consultation ad.');
      await page.getByRole('button', { name: 'Generate creatives', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('#creative-people-slider')?.disabled);
      assert.equal(posts.length, 2); assert.equal(posts[1].peoplePercent, 0); assert.equal(posts[1].useReferenceLibrary, false);
      await page.reload(); await page.waitForFunction(() => document.querySelector('#creative-people-slider')?.value === '0');
      assert.equal(await toggle.isChecked(), false);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, 'controls must fit viewport');
      const bounds = await people.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      await page.screenshot({ path: join(tmpdir(), `tra-image-controls-${width}.png`), fullPage: true });
      assert.deepEqual(errors, []); results.push(`${width}px keyboard/counts/toggle/request/failure/reload`);
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ passed: results }, null, 2));
} finally { await browser.close(); await server.close(); }
