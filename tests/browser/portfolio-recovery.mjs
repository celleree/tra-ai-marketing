import assert from 'node:assert/strict';
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
const server = await createServer({ root, configFile: false, cacheDir: join(tmpdir(), 'tra-portfolio-recovery-vite'),
  plugins: [{ name: 'app-styles', transformIndexHtml: () => [
    { tag: 'meta', attrs: { name: 'viewport', content: 'width=device-width, initial-scale=1' }, injectTo: 'head' },
    ...['/app/globals.css', '/app/ui-sweep.css'].map(href => ({ tag: 'link', attrs: { rel: 'stylesheet', href }, injectTo: 'head' }))] }],
  resolve: { alias: { '@': root, 'node:crypto': root + 'node_modules/next/dist/compiled/crypto-browserify/index.js', ...Object.fromEntries(['buffer', 'events', 'stream', 'string_decoder', 'util', 'vm'].map(name => [name, require.resolve(root + 'node_modules/next/dist/compiled/' + ({ stream: 'stream-browserify', vm: 'vm-browserify' }[name] ?? name))])) } }, oxc: { jsx: { runtime: 'automatic' } },
  server: { host: '127.0.0.1', port: 0 }, define: { 'process.env': '{}', __dirname: JSON.stringify('/'), 'process.browser': 'true', global: 'globalThis' } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/portfolio-recovery.html`;
const browser = await browserTypes[browserName].launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_PATH && browserName === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}) });

const id = `portfolio_${'4'.repeat(32)}`;
const results = [];
const creative = slot => ({ id: slot.creativeId, index: slot.index, category: 'customer-problems', format: 'direct-response',
  copy: { headline: 'Saved headline', primaryText: 'Saved copy', description: '' },
  image: { id: 'media_' + 'a'.repeat(32), fileName: 'saved.png', originalName: 'saved.png', mimeType: 'image/png', size: 100, url: '/saved.png' },
  finalization: { status: 'SAVED', createdAt: '2026-09-11T00:00:00.000Z' } });
try {
  for (const width of [1440, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(), commands = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const job = { id, requestedCount: 6, peoplePercent: 70, useReferenceLibrary: true, planReady: true,
      planningPhase: 'READY_TO_RENDER', planningCheckpoint: 0, planningError: null, lease: null,
      slots: ['SAVED', 'RETRY_REQUIRED', 'RETRY_REQUIRED', 'RETRY_REQUIRED', 'SAVED', 'PENDING'].map((status, i) => ({
        index: i + 1, creativeId: `creative_${String(i + 1).repeat(32)}`, status,
        ...(status === 'RETRY_REQUIRED' ? { error: 'Frame selection requires explicit retry (PROVIDER_FAILED).' } : {}) })) };
    const saved = JSON.stringify(job.slots.filter(slot => slot.status === 'SAVED'));
    let release, firstAdvance = true;
    const response = () => ({ job, creatives: job.slots.filter(slot => slot.status === 'SAVED').map(creative) });
    await page.route('**/api/**', async route => {
      assert.equal(new URL(route.request().url()).pathname, '/api/creatives/portfolios');
      if (route.request().method() === 'GET') { await route.fulfill({ json: response() }); return; }
      const command = route.request().postDataJSON(); commands.push(command);
      assert.equal(command.id, id);
      if (command.action === 'retry') {
        const slot = job.slots[command.slotIndex - 1]; assert.equal(slot.status, 'RETRY_REQUIRED');
        slot.status = 'PENDING'; delete slot.error;
      } else {
        assert.equal(command.action, 'advance');
        if (firstAdvance) {
          firstAdvance = false; await new Promise(resolve => { release = resolve; });
          await route.fulfill({ status: 202, json: response(), headers: { 'Retry-After': '1' } }); return;
        }
        const slot = job.slots.find(slot => slot.status === 'PENDING'); assert.ok(slot); slot.status = 'SAVED';
      }
      await route.fulfill({ json: response() });
    });
    try {
      await page.goto(url + '?portfolio=' + id);
      await page.getByText('2 / 6', { exact: true }).waitFor();
      await page.getByText('Saved mix: 4 with people · 2 without people (70%).', { exact: true }).waitFor();
      assert.equal(commands.length, 0);
      await page.getByRole('button', { name: 'Resume generation', exact: true }).evaluate(button => { button.click(); button.click(); });
      await page.waitForFunction(() => document.querySelector('button')?.textContent === 'Stop generation');
      for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(release, 'explicit Resume must reach one bounded work request');
      const reason = width === 375 ? 'pagehide' : 'hidden';
      await page.evaluate(reason => {
        if (reason === 'pagehide') window.dispatchEvent(new Event('pagehide'));
        else { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }
      }, reason);
      release();
      await page.getByText(reason === 'hidden' ? /when the page became hidden/ : /when the page was left or hidden/).waitFor();
      assert.deepEqual(commands.map(command => command.action), ['advance']);
      await page.reload();
      await page.getByText(reason === 'hidden' ? /when the page became hidden/ : /when the page was left or hidden/).waitFor();
      await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); });
      await page.getByRole('button', { name: 'Resume generation', exact: true }).waitFor();
      assert.equal(commands.length, 1, 'refresh and focus are read-only');
      await page.getByRole('button', { name: 'Prepare retry for ad 2', exact: true }).evaluate(button => { button.click(); button.click(); });
      await page.getByRole('button', { name: 'Prepare retry for ad 2', exact: true }).waitFor({ state: 'detached' });
      assert.deepEqual(commands.map(command => command.action), ['advance', 'retry']);
      assert.deepEqual(job.slots.map(slot => slot.status), ['SAVED', 'PENDING', 'RETRY_REQUIRED', 'RETRY_REQUIRED', 'SAVED', 'PENDING']);
      assert.equal(JSON.stringify(job.slots.filter(slot => [1, 5].includes(slot.index))), saved);
      await page.getByRole('button', { name: 'Resume generation', exact: true }).evaluate(button => { button.click(); button.click(); });
      await page.getByText('4 / 6', { exact: true }).waitFor();
      assert.deepEqual(commands.map(command => command.action), ['advance', 'retry', 'advance', 'advance']);
      assert.deepEqual(job.slots.map(slot => slot.status), ['SAVED', 'SAVED', 'RETRY_REQUIRED', 'RETRY_REQUIRED', 'SAVED', 'SAVED']);
      assert.equal(job.peoplePercent, 70); assert.equal(job.useReferenceLibrary, true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.evaluate(id => localStorage.setItem('tax-marketing-studio-portfolio-continuation-v1:' + id, 'active'), id);
      await page.reload();
      await page.getByText(/the exact event is unknown/).waitFor();
      assert.equal(commands.length, 4, 'unrecorded interruption restores status only');
      assert.deepEqual(errors, []); results.push(`${width}px mixed-six, interruption/reload, read-only focus, prepare/Resume, coalescing`);
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ passed: results }, null, 2));
} finally { await browser.close(); await server.close(); }
