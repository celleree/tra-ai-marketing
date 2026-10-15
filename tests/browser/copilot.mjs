import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url), root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({ root, configFile: false, cacheDir: root + 'node_modules/.vite-copilot',
  resolve: { alias: { '@': root, 'node:crypto': root + 'node_modules/next/dist/compiled/crypto-browserify/index.js',
    ...Object.fromEntries(['buffer', 'events', 'stream', 'string_decoder', 'util', 'vm'].map(name => [name, require.resolve(root + 'node_modules/next/dist/compiled/' + ({ stream: 'stream-browserify', vm: 'vm-browserify' }[name] ?? name))])) } },
  oxc: { jsx: { runtime: 'automatic' } }, server: { host: '127.0.0.1', port: 0 },
  define: { 'process.env': '{}', __dirname: JSON.stringify('/'), 'process.browser': 'true', global: 'globalThis' } });
await server.listen();
const browser = await chromium.launch({ headless: true, ...(process.env.COPILOT_BROWSER_EXECUTABLE ? { executablePath: process.env.COPILOT_BROWSER_EXECUTABLE } : {}) });
const creativeId = `creative_${'a'.repeat(32)}`;
const creative = { id: creativeId, createdAt: '2026-10-11T12:00:00Z', category: 'customer-problems',
  image: { id: `media_${'b'.repeat(32)}`, fileName: 'fixture.png', originalName: 'fixture.png', mimeType: 'image/png', size: 42,
    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l8AAAAASUVORK5CYII=' },
  copy: { headline: 'Saved creative headline', primaryText: 'Saved creative text', description: '' },
  identity: { conceptId: creativeId, parentCreativeId: null, operation: 'GENERATE', fingerprint: 'c'.repeat(64) } };
const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/copilot.html`;
let scenarios = 0;
async function scenario(viewport, available, run) {
  const context = await browser.newContext({ viewport }), page = await context.newPage(); page.setDefaultTimeout(10000);
  const posts = [], errors = []; let mode = 'proposal';
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https:\/\//, route => route.abort()); // No auth, storage or paid provider request is reachable.
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/creatives') return route.fulfill({ json: { items: [creative, { ...creative, id: `creative_${'d'.repeat(32)}`, identity: undefined }] } });
    if (path !== '/api/copilot/recommendations') return route.fulfill({ status: 404, json: { error: 'Offline fixture only.' } });
    if (request.method() === 'GET') return route.fulfill({ json: { available, model: 'claude-sonnet-5-5' } });
    const body = request.postDataJSON(); posts.push(body);
    if (mode === 'network') return route.abort();
    if (mode === 'failure') return route.fulfill({ status: 503, json: { error: 'Copilot service unavailable.' } });
    const approvedText = await page.evaluate(profile => window.fixtureCompanyText(profile ?? undefined), body.companyProfile);
    const record = { version: 1, generatedAt: '2026-10-11T12:00:00Z', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      context: { company: { reference: 'company-fixture', approvedText }, creatives: [{ creativeId, identity: creative.identity, sourceReferences: [] }], performance: 'unknown' },
      observations: [{ text: 'The saved creative uses a headline.', evidenceReferences: [creativeId] }],
      inferences: [{ text: 'A clearer next step may help.', evidenceReferences: ['company-fixture'] }], unknowns: ['No measured revenue is available.'], performance: 'unknown',
      action: mode === 'nothing' ? 'DO_NOTHING' : 'PROPOSE_CREATIVE_TEST',
      recommendation: mode === 'nothing' ? null : { text: 'Test a consultation-focused concept.', soWhat: { surfaceMessage: 'Understand the next step', functionalConsequence: 'Learn the consultation process', meaningfulOutcome: 'Proceed with confidence' } } };
    if (mode === 'mismatch') record.context.creatives[0].creativeId = `creative_${'e'.repeat(32)}`;
    await new Promise(resolve => setTimeout(resolve, 80));
    return route.fulfill({ json: { recommendation: record } });
  });
  try {
    await page.goto(url); await page.getByText('Saved creative headline', { exact: true }).first().waitFor();
    const card = page.locator(`[id="${creativeId}"]`), panel = card.getByRole('region', { name: 'Creative copilot' });
    await card.getByRole('button', { name: 'Suggest next creative test' }).click();
    await panel.getByText(available ? 'This request uses your saved Anthropic key and API credits. Results stay in this panel until the page reloads.' : 'Paid Copilot is unavailable. Save your own key in the Copilot workspace; separate administrator activation is also required.').waitFor();
    await run({ page, panel, posts, mode: value => { mode = value; } });
    assert.deepEqual(errors, []); scenarios++;
  } finally { await context.close(); }
}
try {
  await scenario({ width: 1200, height: 900 }, false, async ({ panel, posts }) => {
    assert.equal(await panel.getByRole('button', { name: 'Request paid suggestion' }).isDisabled(), true);
    assert.equal(await panel.getByRole('checkbox').isDisabled(), true); assert.equal(posts.length, 0);
  });
  await scenario({ width: 1200, height: 900 }, true, async ({ page, panel, posts, mode }) => {
    const button = panel.getByRole('button', { name: 'Request paid suggestion' });
    await panel.getByRole('checkbox').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.body.textContent.includes('Checking copilot availability'));
    assert.equal(await button.isDisabled(), true);
    await panel.getByRole('checkbox').check();
    await button.evaluate(element => { element.click(); element.click(); });
    await panel.getByText('Test a consultation-focused concept.').waitFor();
    assert.equal(posts.length, 1); assert.deepEqual(Object.keys(posts[0]).sort(), ['allowPaidRequest', 'companyContextApproved', 'companyProfile', 'creativeId']);
    assert.equal(posts[0].creativeId, creativeId); assert.equal(posts[0].companyContextApproved, true);
    await page.evaluate(() => localStorage.setItem('tra-company-profile-v2', JSON.stringify({ knowledgeBase: { companySummary: 'Changed approved company context' } })));
    await panel.getByRole('button', { name: 'Refresh company context' }).click();
    assert.equal(await panel.getByRole('checkbox').isChecked(), false); assert.equal(await button.isDisabled(), true);
    await panel.getByRole('checkbox').check(); mode('failure'); await button.click();
    await panel.getByRole('alert').getByText('Copilot service unavailable.').waitFor();
    assert.equal(await panel.getByText('Test a consultation-focused concept.').count(), 1);
    mode('mismatch'); await button.click(); await panel.getByRole('alert').getByText(/mismatched suggestion/).waitFor();
    assert.equal(await panel.getByText('Test a consultation-focused concept.').count(), 1);
    mode('nothing'); await button.click(); await panel.getByText('No creative test is proposed.').waitFor();
    assert.equal(posts.length, 4);
    await page.reload(); await page.getByRole('button', { name: 'Suggest next creative test' }).click();
    assert.equal(await page.getByText('No creative test is proposed.').count(), 0); assert.equal(posts.length, 4);
  });
  await scenario({ width: 375, height: 812 }, true, async ({ page, panel, posts, mode }) => {
    await page.waitForFunction(() => !document.body.textContent.includes('Checking copilot availability'));
    assert.equal(await panel.getByRole('button').evaluateAll(buttons => buttons.every(button => button.getBoundingClientRect().height >= 44)), true);
    assert.equal(await panel.getByRole('checkbox').evaluate(input => input.closest('label').getBoundingClientRect().height >= 44), true);
    await panel.getByRole('checkbox').check(); mode('network'); await panel.getByRole('button', { name: 'Request paid suggestion' }).click();
    await panel.getByRole('alert').getByText(/no automatic retry/).waitFor(); assert.equal(posts.length, 1);
    mode('proposal'); await panel.getByRole('button', { name: 'Request paid suggestion' }).click();
    await panel.getByText('Test a consultation-focused concept.').waitFor(); assert.equal(posts.length, 2);
    assert.equal(await panel.getByText('Performance and revenue: unknown.').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.COPILOT_SCREENSHOT_PATH) await page.screenshot({ path: process.env.COPILOT_SCREENSHOT_PATH, fullPage: true });
  });
  for (const width of [1200, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
    const dummy = 'sk-ant-offline_dummy_0123456789'; let configured = false, revision = null, writes = 0;
    await page.route(/^https:\/\//, route => route.abort());
    await page.route('**/api/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      if (path === '/api/creatives') return route.fulfill({ json: { items: [creative] } });
      if (path === '/api/copilot/recommendations') return route.fulfill({ json: { available: false, model: 'claude-sonnet-5-5' } });
      if (path !== '/api/copilot/key') return route.abort();
      if (req.method() !== 'GET') {
        const body = req.postDataJSON(); assert.equal(body.revision, revision); writes++;
        if (req.method() === 'POST') assert.equal(body.apiKey, dummy);
        configured = req.method() !== 'DELETE'; revision = `revision-${writes}`;
      }
      return route.fulfill({ json: { ready: true, configured, revision, updatedAt: '2026-10-15T12:00:00Z' } });
    });
    try {
      await page.goto(`${url}?workspace`);
      await page.getByText('No key saved.', { exact: true }).waitFor();
      const input = page.getByLabel('New API key'); await input.fill(dummy);
      await page.getByRole('button', { name: 'Save key', exact: true }).click();
      await page.getByRole('button', { name: 'Replace saved key' }).waitFor();
      assert.equal(await input.inputValue(), '');
      assert.equal(await page.evaluate(key => Object.values(localStorage).some(value => value.includes(key)) || Object.values(sessionStorage).some(value => value.includes(key)), dummy), false);
      await input.fill(dummy); await page.getByRole('button', { name: 'Replace saved key' }).click();
      await page.waitForFunction(() => !document.querySelector('fieldset').disabled);
      await page.getByRole('button', { name: 'Remove saved key' }).click();
      await page.getByText('No key saved.', { exact: true }).waitFor(); assert.equal(writes, 3);
      await page.getByLabel('Saved creative', { exact: true }).selectOption(creativeId);
      await page.getByRole('button', { name: 'Suggest next creative test' }).click();
      const panel = page.getByRole('region', { name: 'Creative copilot', exact: true });
      await panel.getByText(/Paid Copilot is unavailable/).waitFor();
      assert.equal(await panel.getByRole('button', { name: 'Request paid suggestion' }).isDisabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); scenarios++;
    } finally { await context.close(); }
  }
  console.log(`PASS ${scenarios} offline Copilot browser scenarios (desktop/mobile); no live providers.`);
} finally { await browser.close(); await server.close(); }
