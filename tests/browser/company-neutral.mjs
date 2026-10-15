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
const server = await createServer({ root, configFile: false, cacheDir: join(tmpdir(), 'tax-company-neutral-vite'),
  plugins: [{ name: 'app-styles', transformIndexHtml: () => [
    { tag: 'meta', attrs: { name: 'viewport', content: 'width=device-width, initial-scale=1' }, injectTo: 'head' },
    ...['/app/globals.css', '/app/ui-sweep.css'].map(href => ({ tag: 'link', attrs: { rel: 'stylesheet', href }, injectTo: 'head' }))] }],
  resolve: { alias: { '@': root, 'node:crypto': root + 'node_modules/next/dist/compiled/crypto-browserify/index.js', ...Object.fromEntries(['buffer', 'events', 'stream', 'string_decoder', 'util', 'vm'].map(name => [name, require.resolve(root + 'node_modules/next/dist/compiled/' + ({ stream: 'stream-browserify', vm: 'vm-browserify' }[name] ?? name))])) } }, oxc: { jsx: { runtime: 'automatic' } },
  server: { host: '127.0.0.1', port: 0 }, define: { 'process.env': '{}', __dirname: JSON.stringify('/'), 'process.browser': 'true', global: 'globalThis' } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/company-neutral.html`;
const browser = await browserTypes[browserName].launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_PATH && browserName === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}) });


const id = `media_${'a'.repeat(32)}`;
const results = [];
try {
  for (const width of [1440, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem('tra-company-profile-v2', JSON.stringify({ knowledgeBase: { companySummary: 'Old TRA claims', proof: 'Old case study' }, brandGuidelines: { logo: '/api/media/files/media_77777777777777777777777777777777.png' } }));
      localStorage.setItem('tra-create-video-ids-v1', JSON.stringify(['media_88888888888888888888888888888888']));
      localStorage.setItem('tra-creative-portfolio-v1', 'portfolio_44444444444444444444444444444444');
      localStorage.setItem('tra-video-review-draft-v1', 'review_44444444444444444444444444444444');
    });
    const page = await context.newPage(); const errors = [], posts = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/creatives/portfolios' && request.method() === 'POST') {
        posts.push(request.postDataJSON()); await route.fulfill({ status: 400, json: { error: 'Offline verification: no job or provider operation created.' } }); return;
      }
      if (path === '/api/references') { await route.fulfill({ json: { items: [{ id, mediaType: 'IMAGE', mimeType: 'image/png', fileName: `${id}.png`, originalName: 'Own layout.png', url: `/api/media/files/${id}.png`, referenceType: 'layout', angle: 'customer-problems', angleSource: 'manual', addedAt: '2026-10-15T00:00:00Z' }] } }); return; }
      if (path === `/api/media/files/${id}.png`) { await route.fulfill({ contentType: 'image/png', body: await sharp({ create: { width: 100, height: 100, channels: 4, background: '#fff' } }).png().toBuffer() }); return; }
      throw new Error(`Unexpected API access: ${request.method()} ${path}`);
    });
    try {
      await page.goto(url);
      const people = page.getByRole('slider', { name: 'Ads with people', exact: true });
      await people.waitFor(); assert.equal(await people.inputValue(), '50');
      assert.equal(await page.getByRole('switch').isChecked(), true);
      await people.focus(); await page.keyboard.press('Home'); await page.getByRole('switch').uncheck();
      await page.locator('textarea').fill('Create a generic tax guidance ad.');
      await page.getByRole('button', { name: 'Generate creatives', exact: true }).click();
      await page.getByText('Offline verification: no job or provider operation created.', { exact: true }).first().waitFor();
      assert.equal(posts.length, 1); assert.equal(posts[0].peoplePercent, 0); assert.equal(posts[0].useReferenceLibrary, false);
      assert.deepEqual(posts[0].sourceAssets, []); assert.deepEqual(posts[0].companySourceScope, { version: 1, referenceIds: [] });
      assert.equal(posts[0].companyProfile, undefined); assert.equal(posts[0].brandLogoMediaId, undefined);
      assert.ok(await page.evaluate(() => localStorage.getItem('tra-company-profile-v2')?.includes('Old TRA claims')));
      await page.goto(`${url}?references`);
      const use = page.getByRole('checkbox', { name: 'Use Own layout.png for this company' });
      await use.waitFor(); assert.equal(await use.isChecked(), false); await use.check();
      await page.reload(); await use.waitFor(); await page.waitForFunction(() => document.querySelector('input[aria-label="Use Own layout.png for this company"]')?.checked);
      assert.equal(await use.isChecked(), true); await use.uncheck();
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('tax-marketing-studio:reference-selection:v1'))).then(ids => ids.length), 0);
      assert.deepEqual(errors, []); results.push(`${width}px fresh no-assets request / legacy preservation / explicit reference selection and refresh`);
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ passed: results }, null, 2));
} finally { await browser.close(); await server.close(); }
