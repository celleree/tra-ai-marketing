import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url), root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({ root, configFile: false, cacheDir: root + 'node_modules/.vite-workspaces',
  resolve: { alias: { '@': root, 'node:crypto': root + 'node_modules/next/dist/compiled/crypto-browserify/index.js',
    ...Object.fromEntries(['buffer', 'events', 'stream', 'string_decoder', 'util', 'vm'].map(name => [name, require.resolve(root + 'node_modules/next/dist/compiled/' + ({ stream: 'stream-browserify', vm: 'vm-browserify' }[name] ?? name))])) } },
  oxc: { jsx: { runtime: 'automatic' } }, server: { host: '127.0.0.1', port: 0 },
  define: { 'process.env': '{}', __dirname: JSON.stringify('/'), 'process.browser': 'true', global: 'globalThis' } });
await server.listen();
const browser = await chromium.launch({ headless: true, ...(process.env.WORKSPACE_BROWSER_CHANNEL ? { channel: process.env.WORKSPACE_BROWSER_CHANNEL } : {}) });
const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/workspaces.html?keep=1&workspace=copilot`;
let scenarios = 0;
try {
  for (const width of [1200, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
    page.setDefaultTimeout(15000); const writes = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https:\/\//, route => route.abort());
    await page.route('**/api/**', route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') writes.push(path);
      const value = path === '/api/copilot/key' ? { ready: false, configured: false, revision: null, updatedAt: null }
        : path === '/api/ai-videos' ? { accessEnabled: false, paidEnabled: false, jobs: [] }
        : path === '/api/discovery' ? { available: false, sessions: [] } : { items: [], jobs: [], sources: [] };
      return route.fulfill({ json: value });
    });
    await page.addInitScript(() => { if (!sessionStorage.getItem('fixture-seeded')) {
      sessionStorage.setItem('fixture-seeded', 'yes');
      localStorage.setItem('tra-company-profile-v2', JSON.stringify({ brandGuidelines: { logo: `/api/media/files/media_${'a'.repeat(32)}.png` } }));
      sessionStorage.setItem('tra-ai-marketing:landing-creative-draft', JSON.stringify({ version: 2, context: 'STALE PAID HANDOFF', sourceAsset: null, variationCount: 2, generateOnOpen: true }));
    } });
    try {
      await page.goto(url); await page.getByRole('heading', { name: 'Claude Copilot', exact: true }).waitFor();
      await page.getByText('Key storage requires administrator setup.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Save key', exact: true }).isDisabled(), true);
      const nav = page.getByRole('navigation', { name: 'Creative workspace' });
      for (const [name, section] of [['AI Videos', 'ai-videos'], ['Discovery', 'discovery'], ['Copilot', 'copilot']]) {
        await nav.getByRole('button', { name, exact: true }).click();
        await page.locator('.workspace-section-header h1').filter({ hasText: name }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get('workspace'), section);
        assert.equal(new URL(page.url()).searchParams.get('keep'), '1');
        await page.reload(); await page.locator('.workspace-section-header h1').filter({ hasText: name }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} fits the viewport: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('*')].filter(element => element.getBoundingClientRect().right > innerWidth + 1).map(element => ({ tag: element.tagName, type: element.getAttribute('type'), width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right })).slice(0, 15)))}`);
      }
      const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('tra-ai-marketing:landing-creative-draft')));
      assert.equal(draft.context, 'STALE PAID HANDOFF'); assert.equal(draft.generateOnOpen, false);
      await nav.getByRole('button', { name: 'Create', exact: true }).click();
      await page.reload(); await page.getByRole('heading', { name: 'Create', exact: true }).waitFor();
      await page.getByRole('textbox').filter({ visible: true }).first().waitFor();
      assert.equal(await page.locator('textarea').first().inputValue(), 'STALE PAID HANDOFF');
      assert.equal(await page.getByRole('button', { name: 'Generate creatives', exact: true }).isEnabled(), true);
      // Let normal automatic-handoff effects settle with valid saved brand settings.
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('tra-ai-marketing:landing-creative-draft')), null);
      await page.reload(); await page.getByRole('heading', { name: 'Create', exact: true }).waitFor();
      await page.waitForTimeout(100);
      assert.deepEqual(writes, []); assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); scenarios++;
    } finally { await context.close(); }
  }
  console.log(`PASS ${scenarios} desktop/mobile workspace navigation/refresh and stale-paid-handoff scenarios; zero writes.`);
} finally { await browser.close(); await server.close(); }
