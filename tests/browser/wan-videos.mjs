import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({ root, configFile: false, cacheDir: root + 'node_modules/.vite-wan',
  resolve: { alias: { '@': root } }, oxc: { jsx: { runtime: 'automatic' } }, server: { host: '127.0.0.1', port: 0 } });
await server.listen(); const browser = await chromium.launch({ headless: true, ...(process.env.WAN_BROWSER_CHANNEL ? { channel: process.env.WAN_BROWSER_CHANNEL } : {}) });
const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/wan-videos.html`;
let scenarios = 0;
try {
  for (const width of [1200, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }); const page = await context.newPage();
    page.setDefaultTimeout(10000); const errors = []; const posts = []; let enabled = false; let paid = false; let jobs = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https:\/\//, route => route.abort());
    await page.route('**/api/**', async route => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      if (request.method() === 'GET' && path === '/api/ai-videos') return route.fulfill({ json: { accessEnabled: enabled, paidEnabled: paid, jobs } });
      if (request.method() === 'POST') posts.push({ path, body: request.postDataJSON() });
      if (path === '/api/media/upload-url') return route.fulfill({ json: { direct: true, uploadUrl: 'http://127.0.0.1:1/mock-put', media: { id: 'media_' + (request.postDataJSON().sourceRole === 'TRA_VIDEO' ? 'a' : 'b').repeat(32), fileName: 'fixture.mp4', url: '/api/media/files/fixture.mp4', mediaType: request.postDataJSON().sourceRole === 'TRA_VIDEO' ? 'VIDEO' : 'IMAGE', mimeType: request.postDataJSON().mimeType } } });
      if (path === '/api/media/confirm') return route.fulfill({ json: { ok: true } });
      if (path === '/api/ai-videos' && request.method() === 'POST') {
        jobs = [{ id: '12345678-1234-1234-1234-123456789abc', createdAt: Date.now(), updatedAt: Date.now(), state: 'QUOTED', profile: request.postDataJSON().profile,
          mode: request.postDataJSON().mode, resolution: request.postDataJSON().resolution, quote: { id: 'quote-fixture', frames: 32, durationMs: 1333, estimatedCents: 8, pricingVersion: 'fal-wan-2026-10-15', expiresAt: Date.now() + 600000 } }];
        return route.fulfill({ json: { job: jobs[0] } });
      }
      if (path.endsWith('/output') && request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'video/mp4', body: 'offline synthetic output' });
      if (path.startsWith('/api/ai-videos/')) {
        const action = request.postDataJSON().action;
        jobs[0] = { ...jobs[0], state: action === 'launch' ? 'UNKNOWN' : 'SUCCEEDED', ...(action === 'refresh' ? { outputUrl: '/api/ai-videos/' + jobs[0].id + '/output' } : {}), message: 'Submission outcome is unknown. Do not launch a replacement until administrator reconciliation.' };
        return route.fulfill({ json: { job: jobs[0] } });
      }
      return route.fulfill({ status: 404, json: { error: 'Offline fixture only.' } });
    });
    await page.route('http://127.0.0.1:1/mock-put', route => route.fulfill({ status: 200, body: '' }));
    try {
      await page.goto(url); await page.getByText('AI Videos is disabled.', { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Upload privately and prepare quote' }).isDisabled(), true);
      enabled = true; await page.getByRole('button', { name: 'Restore jobs' }).click(); await page.getByText('Paid generation is disabled.', { exact: false }).waitFor();
      assert.equal(posts.length, 0); paid = true; await page.getByRole('button', { name: 'Restore jobs' }).click();
      await page.getByLabel('Character profile name').fill('Offline character'); await page.getByLabel('Profile notes').fill('Organizational metadata only');
      await page.getByLabel('Character image').setInputFiles({ name: 'dummy.png', mimeType: 'image/png', buffer: Buffer.from('synthetic offline file') });
      await page.getByLabel('Motion source MP4').setInputFiles({ name: 'dummy.mp4', mimeType: 'video/mp4', buffer: Buffer.from('synthetic offline file') });
      await page.getByRole('button', { name: 'Upload privately and prepare quote' }).click();
      const dialog = page.getByRole('dialog'); await dialog.waitFor(); const launch = dialog.getByRole('button', { name: 'Launch paid generation' });
      assert.equal(await launch.isDisabled(), true); assert.equal(posts.filter(post => post.body?.action === 'launch').length, 0);
      await dialog.getByRole('checkbox').nth(0).check(); await dialog.getByRole('checkbox').nth(1).check(); assert.equal(await launch.isDisabled(), true);
      await dialog.getByRole('checkbox').nth(2).check(); await launch.click();
      await page.getByText('Automatic resubmission is blocked.', { exact: false }).waitFor();
      const launches = posts.filter(post => post.body?.action === 'launch'); assert.equal(launches.length, 1);
      assert.equal(launches[0].body.quoteId, 'quote-fixture'); assert.equal(launches[0].body.rightsConfirmed, true);
      await page.reload(); await page.getByText('Automatic resubmission is blocked.', { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Launch paid generation' }).count(), 0);
      jobs[0] = { ...jobs[0], state: 'RECOVERY', message: 'Resume the accepted request without a new purchase.' }; paid = false;
      await page.reload(); await page.getByRole('button', { name: 'Refresh / resume accepted request' }).click();
      await page.getByText('SUCCEEDED', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Offline character generated video').count(), 1);
      assert.equal(posts.filter(post => post.body?.action === 'launch').length, 1);
      assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); scenarios++;
    } finally { await context.close(); }
  }
  console.log(`PASS ${scenarios} offline Wan video desktop/mobile scenarios; no live providers or uploads.`);
} finally { await browser.close(); await server.close(); }
