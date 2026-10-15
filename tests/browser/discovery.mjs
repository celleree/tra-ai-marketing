import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({ root, configFile: false, cacheDir: root + 'node_modules/.vite-discovery', resolve: { alias: { '@': root } }, oxc: { jsx: { runtime: 'automatic' } }, server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}) });
const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/discovery.html`;
const candidate = (id, name) => ({ id, adId: id, advertiser: name, sourceUrl: `https://www.facebook.com/ads/library/?id=${id}`, imageUrl: 'https://scontent.xx.fbcdn.net/fixture.png', text: 'Free consultation for a practical customer problem.', startDate: null, endDate: null, status: 'unknown', observedAt: '2026-10-15T00:00:00Z', provider: 'sample', runId: 'runABC', score: 3, reasons: ['Copy matches: consultation', 'Advertiser diversity'], inference: { angle: 'problem-led copy', offer: 'free', layout: 'unknown', humanPresence: 'unknown' }, performance: 'unknown' });
let scenarios = 0;
async function scenario(viewport, enabled, run) {
  const context = await browser.newContext({ viewport }), page = await context.newPage(), posts = [], errors = [];
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  let session, failSecondImport = false;
  await page.route(/^https:\/\//, route => route.abort());
  await page.route('**/api/discovery**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/preview')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l8AAAAASUVORK5CYII=', 'base64') });
    if (request.method() === 'GET') return route.fulfill({ json: new URL(request.url()).searchParams.has('session') ? { session } : { providerAvailable: enabled, visualAnalysisAvailable: enabled } });
    const body = request.postDataJSON(); posts.push(body);
    if (body.action === 'sample' || body.action === 'search') session = { version: 1, id: 'a'.repeat(32), createdAt: '2026-10-15T00:00:00Z', search: { query: body.query, limit: body.limit, preferTax: body.preferTax }, sample: body.action === 'sample', run: body.action === 'search' ? { id: 'runABC', status: 'SUCCEEDED' } : undefined, candidates: [candidate('10001', 'Tax fixture'), candidate('10002', 'Fitness fixture')], exactDuplicates: 0, imports: {}, feedback: {} };
    if (body.action === 'import') {
      if (failSecondImport && body.candidateId === '10002') return route.fulfill({ status: 400, json: { error: 'Second source expired. Use the manual image fallback.' } });
      session.imports[body.candidateId] = { id: `media_${body.candidateId}` };
    }
    if (body.action === 'feedback') session.feedback[body.candidateId] = body.decision;
    if (body.action === 'analyze') { session.analysisAttempts = { [body.candidateId]: 'succeeded' }; session.visualEvidence = { [body.candidateId]: { basis: 'model-inference', model: 'fixture-model', analyzedAt: '2026-10-15T00:00:00Z', imageSha256: 'b'.repeat(64), layout: 'GRID', humanPresence: 'present', angle: 'customer-problems', offer: 'free-consultation' } }; }
    return route.fulfill({ json: { session, ...(body.action === 'import' ? { imported: `media_${body.candidateId}` } : {}) } });
  });
  try { await page.goto(url); await run({ page, posts, failSecond: () => { failSecondImport = true; } }); assert.deepEqual(errors, []); scenarios++; }
  finally { await context.close(); }
}
try {
  await scenario({ width: 1200, height: 900 }, false, async ({ page, posts }) => {
    await page.getByText(/Live provider disabled/).waitFor(); assert.equal(await page.getByRole('button', { name: 'Search provider (paid)' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Explore offline samples' }).click(); await page.getByRole('heading', { name: 'Fitness fixture' }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Import .*selected/ }).count(), 0); assert.equal(posts.length, 1); assert.equal(posts[0].limit, 10);
    assert.equal(await page.getByRole('button', { name: 'Approve reference idea' }).first().isDisabled(), true);
    await page.getByRole('checkbox', { name: /Save my approval feedback/ }).check(); await page.getByRole('button', { name: 'Approve reference idea' }).first().click();
    await page.getByText('Your private feedback: approved').waitFor(); assert.equal(posts[1].optIn, true);
  });
  await scenario({ width: 375, height: 812 }, true, async ({ page, posts, failSecond }) => {
    await page.getByText('Live provider search is enabled and can incur charges.').waitFor(); await page.getByRole('button', { name: 'Search provider (paid)' }).evaluate(button => { button.click(); button.click(); });
    await page.getByRole('heading', { name: 'Tax fixture' }).waitFor();
    assert.equal(posts.filter(post => post.action === 'search').length, 1);
    assert.equal(await page.getByRole('button', { name: 'Analyze visual pattern (paid)' }).first().isDisabled(), true);
    await page.getByRole('checkbox', { name: /I approve the image transfer/ }).check(); await page.getByRole('button', { name: 'Analyze visual pattern (paid)' }).first().click();
    await page.getByText(/Visual model inference: layout GRID/).waitFor(); assert.equal(posts.filter(post => post.action === 'analyze').length, 1);
    await page.getByRole('checkbox', { name: 'Select for import' }).nth(0).check(); await page.getByRole('checkbox', { name: 'Select for import' }).nth(1).check();
    assert.equal(await page.getByRole('button', { name: 'Import 2 selected reference(s)' }).isDisabled(), true);
    await page.getByRole('checkbox', { name: /I may store these images/ }).check(); failSecond(); await page.getByRole('button', { name: 'Import 2 selected reference(s)' }).click();
    await page.getByRole('alert').getByText(/Second source expired/).waitFor(); assert.equal(await page.getByRole('checkbox', { name: 'Select for import' }).nth(0).isChecked(), false); assert.equal(await page.getByRole('checkbox', { name: 'Select for import' }).nth(1).isChecked(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('*')].filter(element => element.getBoundingClientRect().right > innerWidth + 1).map(element => ({ tag: element.tagName, type: element.getAttribute('type'), width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right })).slice(0, 15))));
    if (process.env.DISCOVERY_SCREENSHOT_PATH) await page.screenshot({ path: process.env.DISCOVERY_SCREENSHOT_PATH, fullPage: true });
    await page.reload(); await page.getByRole('heading', { name: 'Tax fixture' }).waitFor(); assert.equal(posts.filter(post => post.action === 'search').length, 1);
  });
  console.log(`PASS ${scenarios} offline discovery desktop/mobile scenarios; no live providers or media.`);
} finally { await browser.close(); await server.close(); }
