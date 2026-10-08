import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

// Use an already installed Playwright package; do not add a production dependency or fetch providers.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({ root, configFile: false, cacheDir: '/tmp/tra-slice4-vite-cache',
  plugins: [{ name: 'app-styles', transformIndexHtml: () => [
    { tag: 'meta', attrs: { name: 'viewport', content: 'width=device-width, initial-scale=1' }, injectTo: 'head' },
    ...['/app/globals.css', '/app/ui-sweep.css'].map(href => ({ tag: 'link', attrs: { rel: 'stylesheet', href }, injectTo: 'head' }))] }],
  resolve: { alias: { '@': root, 'node:crypto': root + 'node_modules/next/dist/compiled/crypto-browserify/index.js', ...Object.fromEntries(['buffer', 'events', 'stream', 'string_decoder', 'util', 'vm'].map(name => [name, require.resolve(root + 'node_modules/next/dist/compiled/' + ({ stream: 'stream-browserify', vm: 'vm-browserify' }[name] ?? name))])) } }, oxc: { jsx: { runtime: 'automatic' } },
  server: { host: '127.0.0.1', port: 0 }, define: { 'process.env': '{}', __dirname: JSON.stringify('/'), 'process.browser': 'true', global: 'globalThis' } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/video-review.html`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}) });
const id = `review_${'a'.repeat(32)}`, mediaId = `media_${'b'.repeat(32)}`;
const availableB = `media_${'9'.repeat(32)}`, availableC = `media_${'8'.repeat(32)}`;
const video = { locator: { version: 1, sourceVideoMediaId: mediaId, sourceVideoContentHash: 'c'.repeat(64), analyzerFingerprintSha256: 'd'.repeat(64) },
  libraryId: `video-library:${'e'.repeat(64)}`, librarySha256: 'f'.repeat(64), preparationSha256: '1'.repeat(64) };
const frame = { frameId: `video-frame:${'2'.repeat(64)}`, representativeFrameId: `video-frame:${'2'.repeat(64)}`, candidateIndex: 0, timestampMs: 1000, frameSha256: '3'.repeat(64) };
const media = { id: mediaId, fileName: 'fixture.mp4', originalName: 'fixture.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', size: 42, url: '/fixture.mp4' };
const profile = { knowledgeBase: { servicesOffers: 'Saved consultation offer.' } };
const claim = { type: 'VIDEO_TRANSCRIPT', startSegmentIndex: 0, endSegmentIndex: 0 };
const segment = { segmentIndex: 0, startMs: 0, endMs: 2000, text: 'Exact saved video wording.' };
const job = (status = 'BLOCKED') => ({ id: `portfolio_${'4'.repeat(32)}`, requestedCount: 4, planReady: true, planningPhase: 'READY_TO_RENDER',
  planningCheckpoint: 0, planningError: null, lease: null, slots: Array.from({ length: 4 }, (_, i) => ({ index: i + 1,
    creativeId: `creative_${String(i + 5).repeat(32)}`, status, ...(status === 'BLOCKED' ? { error: 'Offline fixture stop.' } : {}) })) });
const thumbnails = await Promise.all([[180, 320], [320, 180]].map(async ([width, height]) =>
  'data:image/png;base64,' + (await sharp(Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#cddbe8"/><text x="8" y="18">TOP CAPTION</text><text x="8" y="${height - 8}">BOTTOM CAPTION</text></svg>`)).png().toBuffer()).toString('base64')));
const results = [];
async function scenario(name, options, run) {
  if (process.env.VIDEO_REVIEW_SCENARIO && !name.includes(process.env.VIDEO_REVIEW_SCENARIO)) return;
  const context = await browser.newContext(options.width ? { viewport: { width: options.width, height: 900 }, isMobile: true, hasTouch: true } : {});
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = [], calls = [], submissions = [], videoActions = [];
  page.on('pageerror', error => errors.push(error.message));
  let choices = { video, frames: options.frames === undefined ? [frame] : options.frames, claims: [claim], companyProfile: options.profile ? profile : null };
  const bindings = Array.from({ length: options.frameCount ?? 1 }, (_, index) => index ? { ...frame,
    frameId: `video-frame:${String(index + 4).repeat(64)}`, candidateIndex: index, timestampMs: (index + 1) * 1000 } : frame);
  if (options.savedNeighbors) choices.frames = bindings.slice(1);
  const previewBatches = [], previewActivity = { active: 0, peak: 0 }; let previewFailure = Boolean(options.failPreviews), brokenPreview = Boolean(options.brokenPreview);
  const saves = []; let failure = 0, loadFailure = 0, sourceFailure = 0, revisionNumber = 1;
  let revision = 'revision-1', phase = options.phase ?? 'COMPLETE', issue = options.issue;
  const response = () => ({ draft: { id, version: 1, artifactType: 'VIDEO_REVIEW_DRAFT', providerEligible: false,
    choices, claimSnapshots: [{ reference: claim, wording: segment.text, context: { type: 'VIDEO_TRANSCRIPT', segments: [segment] } }], updatedAtMs: 1 },
    revision, issues: issue ? [{ source: 'VIDEO', message: issue }] : [], transcriptContext: null, profileSource: null });
  await context.addInitScript(({ id, inventory, profile, hasProfile }) => {
    if (sessionStorage.getItem('video-review-fixture-seeded')) return;
    sessionStorage.setItem('video-review-fixture-seeded', 'true');
    localStorage.setItem('tra-video-review-draft-v1', id);
    localStorage.setItem('tra-create-video-ids-v1', JSON.stringify(inventory));
    if (hasProfile) localStorage.setItem('tra-company-profile-v2', JSON.stringify({ websiteUrl: '', brandGuidelines: {}, guardrails: {}, ...profile }));
  }, { id, inventory: options.inventory ?? [mediaId], profile, hasProfile: options.profile });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, body = request.postDataJSON();
    calls.push([path, request.method()]);
    const requestedId = new URL(request.url()).searchParams.get('mediaId') ?? mediaId;
    const missing = options.missingMedia || (options.missingReviewed && requestedId === mediaId);
    const currentVideo = { ...video, locator: { ...video.locator, sourceVideoMediaId: requestedId } };
    const currentMedia = { ...media, id: requestedId, originalName: requestedId === mediaId ? 'fixture.mp4' : requestedId === availableB ? 'second.mp4' : 'third.mp4' };
    let value = {}, status = 200, isPreview = false;
    if (path === '/api/video/review-selection') {
      if ((request.method() === 'POST' && failure) || (request.method() === 'GET' && loadFailure)) {
        status = request.method() === 'POST' ? failure : loadFailure; failure = 0; value = { error: 'Fixture denial or failure.' };
      } else if (options.missingDraft) { status = 404; value = { error: 'Review draft was not found.' }; }
      else { if (request.method() === 'POST') { saves.push(body); if (options.saveDelay) await new Promise(resolve => setTimeout(resolve, options.saveDelay));
        assert.equal(body.expectedRevision, revision); choices = body.choices; revision = `revision-${++revisionNumber}`; issue = undefined; } value = response(); }
    } else if (path === '/api/video/intelligence/jobs') {
      if (request.method() === 'POST') { videoActions.push(body.action); phase = 'COMPLETE'; value = { phase, locator: video.locator, busy: false }; }
      else if (missing) { status = 404; value = { error: 'Stored video is missing.' }; }
      else value = { source: currentMedia, locator: currentVideo.locator, status: { phase, locator: currentVideo.locator, busy: false } };
    } else if (path === '/api/video/intelligence/library') value = {};
    else if (path === '/api/video/review-sources') {
      if (request.method() === 'POST') value = { statements: [], companyProfile: body.companyProfile };
      else if (sourceFailure) { status = sourceFailure; sourceFailure = 0; value = { error: 'Source session failed.' }; }
      else if (missing) { status = 404; value = { error: 'Stored video is missing.' }; }
      else value = { source: currentMedia, status: { phase, locator: currentVideo.locator, completedRepresentatives: 1, totalRepresentatives: 1, busy: false,
        failure: { message: 'Fixture preparation failed.' }, retry: { message: 'Uncertain prior attempt.' } },
        review: phase !== 'COMPLETE' ? null : { video: currentVideo, frameBindings: bindings, onScreenStatements: [], library: { transcript: { segments: [segment] },
          representativeFrames: bindings.slice(0, options.savedNeighbors ? 1 : bindings.length).map((binding, index) => ({ ...binding, id: binding.frameId, thumbnailDataUrl: thumbnails[index % 2] })) } } };
      const indexes = new URL(request.url()).searchParams.get('candidateIndexes');
      if (indexes && value.review) {
        const batch = indexes.split(',').map(Number); previewBatches.push(batch); isPreview = true;
        previewActivity.active++; previewActivity.peak = Math.max(previewActivity.peak, previewActivity.active);
        assert.ok(batch.length <= 24);
        if (options.previewDelay) await new Promise(resolve => setTimeout(resolve, options.previewDelay));
        if (previewFailure) { status = 409; value = { error: 'Fixture preview extraction failed.' }; }
        else value.review.previews = batch.map(index => ({ binding: bindings[index], providerEligible: false,
          thumbnailDataUrl: brokenPreview ? 'data:image/jpeg;base64,broken' : thumbnails[index % 2] }));
      }
    } else if (path === '/api/creatives/portfolios') {
      if (request.method() === 'POST') { submissions.push(body); if (options.generationDelay) await new Promise(resolve => setTimeout(resolve, options.generationDelay)); }
      const state = request.method() === 'GET' ? options.portfolioState ?? 'BLOCKED' : request.method() === 'PATCH' ? 'SAVED' : 'BLOCKED';
      if (options.invalidRevision && request.method() === 'POST') { status = 409; value = { error: 'Review draft changed. Reload the saved review before generating.' }; }
      else value = { job: job(state), creatives: [] };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (isPreview) previewActivity.active--;
  });
  // Abort every external request; the harness never reaches an auth, storage or provider service.
  await page.route(/^https:\/\//, route => route.abort());
  try {
    await page.goto(url);
    await page.getByRole('button', { name: 'Generate creatives', exact: true }).waitFor();
    await page.waitForFunction(() => !document.body.textContent.includes('Restoring saved videos'));
    await run({ page, calls, submissions, videoActions, response, bindings, saves, previewBatches, previewActivity, recoverPreviews: () => { previewFailure = false; brokenPreview = false; }, failNext: status => { failure = status; }, denyLoads: status => { loadFailure = status; }, failSource: status => { sourceFailure = status; } });
    assert.deepEqual(errors, [], 'Browser runtime errors');
    results.push(name); console.log(`PASS ${name}`);
  } finally { await context.close(); }
}
const generateButton = page => page.getByRole('button', { name: 'Generate creatives', exact: true });
const ready = async page => { await page.locator('textarea').fill('Create four distinct concepts.'); await page.getByText('Video material ready').waitFor(); };
try {
  for (const status of [401, 403, 409, 503]) await scenario(`Failed save ${status} blocks second frame and preserves saved choices`,
    { frameCount: 5 }, async ({ page, failNext, calls, response, bindings, denyLoads }) => {
      await ready(page); const panel = page.getByRole('region', { name: 'Video material review' });
      const checks = panel.locator('label:has(img) input[type=checkbox]'); failNext(status); await checks.nth(1).check();
      await page.waitForFunction(() => document.body.textContent.includes('Save failed') || document.body.textContent.includes('Conflict / reload required'));
      assert.equal(await checks.nth(2).isDisabled(), true);
      assert.deepEqual(response().draft.choices.frames, [frame]);
      const expected = { 401: 'Sign in again', 403: 'approved TRA operator', 409: 'newer saved revision', 503: 'could not be confirmed' }[status];
      await panel.getByText(expected, { exact: false }).waitFor();
      denyLoads(status); await page.getByRole('button', { name: 'Reload saved review', exact: true }).click();
      await page.waitForFunction(() => !document.body.textContent.includes('Saving…'));
      assert.equal(await checks.nth(2).isDisabled(), true); assert.deepEqual(response().draft.choices.frames, [frame]);
      denyLoads(0); await page.getByRole('button', { name: 'Reload saved review', exact: true }).click();
      await checks.nth(2).waitFor(); await page.waitForFunction(() => !document.body.textContent.includes('Saving…'));
      assert.equal(await checks.nth(0).isChecked(), true); assert.equal(await checks.nth(1).isChecked(), false);
      await checks.nth(2).check(); await page.getByText('Saved ✓').waitFor();
      assert.deepEqual(response().draft.choices.frames, [frame, bindings[2]]);
      assert.equal(calls.filter(([path, method]) => path === '/api/video/review-selection' && method === 'POST').length, 2);
    });
  await scenario('Failed first frame save explains the stuck 1-selected state and recovers', { frames: null, frameCount: 5 }, async ({ page, failNext, response, bindings }) => {
    await ready(page); const panel = page.getByRole('region', { name: 'Video material review' });
    const checks = panel.locator('label:has(img) input[type=checkbox]'); failNext(401); await checks.nth(0).check();
    await panel.getByText('HTTP 401:', { exact: false }).waitFor(); await panel.getByText('1 selected', { exact: true }).first().waitFor();
    assert.equal(await checks.nth(1).isDisabled(), true); assert.equal(response().draft.choices.frames, null);
    await page.getByRole('button', { name: 'Reload saved review', exact: true }).click();
    await page.waitForFunction(() => !document.body.textContent.includes('Saving…'));
    await checks.nth(0).check(); await checks.nth(1).check(); await page.getByText('Saved ✓').waitFor();
    assert.deepEqual(response().draft.choices.frames, bindings.slice(0, 2));
  });
  await scenario('Source authentication failure has reload recovery without replacing saved selections', {}, async ({ page, failSource, response }) => {
    await ready(page); const before = structuredClone(response()); failSource(401);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const panel = page.getByRole('region', { name: 'Video material review' });
    await panel.getByText('Sign in again', { exact: false }).waitFor();
    await panel.getByRole('button', { name: 'Reload video material' }).click(); await page.getByText('Video material ready').waitFor();
    assert.equal(await panel.getByText('Sign in again', { exact: false }).count(), 0); assert.deepEqual(response(), before);
  });
  await scenario('Active generation explains disabled frame selection and releases it when settled', { generationDelay: 1000 }, async ({ page, response }) => {
    await ready(page); const before = structuredClone(response()); await generateButton(page).click();
    const panel = page.getByRole('region', { name: 'Video material review' });
    await panel.getByText('Stop or finish generation', { exact: false }).waitFor();
    assert.equal(await panel.getByRole('checkbox').first().isDisabled(), true);
    await page.getByText('Generation needs attention.').waitFor();
    assert.equal(await panel.getByRole('checkbox').first().isDisabled(), false); assert.deepEqual(response(), before);
  });
  await scenario('First second fifth selections and rapid toggles persist settled revisions on refresh',
    { frames: null, frameCount: 5, saveDelay: 100 }, async ({ page, response, saves, bindings }) => {
      await ready(page); const checks = page.getByRole('region', { name: 'Video material review' }).locator('label:has(img) input[type=checkbox]');
      await checks.nth(0).check(); await checks.nth(1).check(); await checks.nth(2).check(); await checks.nth(3).check(); await checks.nth(4).check();
      await checks.nth(1).uncheck(); await checks.nth(1).check(); await checks.nth(1).uncheck();
      await page.getByText('Saved ✓').waitFor();
      assert.deepEqual(response().draft.choices.frames, [bindings[0], bindings[2], bindings[3], bindings[4]]);
      assert.deepEqual(saves.map(body => body.expectedRevision), Array.from({ length: 8 }, (_, index) => `revision-${index + 1}`));
      const before = structuredClone(response()); await page.reload(); await ready(page);
      assert.deepEqual(response(), before); assert.equal(saves.length, 8);
      assert.deepEqual(await checks.evaluateAll(inputs => inputs.map(input => input.checked)), [true, false, true, true, true]);
    });
  for (const width of [375, 390, 430]) await scenario(`Uncropped mobile thumbnails at ${width}px`,
    { width, frames: null, frameCount: 5 }, async ({ page, response }) => {
      await ready(page); const panel = page.getByRole('region', { name: 'Video material review' });
      const images = panel.locator('img'); await images.first().waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('img')].every(image => image.complete && image.naturalWidth));
      assert.equal(await page.evaluate(() => innerWidth), width);
      const dimensions = await images.evaluateAll(images => images.map(image => ({ natural: image.naturalWidth / image.naturalHeight,
        rendered: image.getBoundingClientRect().width / image.getBoundingClientRect().height, fit: getComputedStyle(image).objectFit })));
      for (const image of dimensions) { assert.ok(Math.abs(image.natural - image.rendered) < 0.01); assert.notEqual(image.fit, 'cover'); }
      const strip = images.first().locator('..').locator('..').locator('..');
      const start = await strip.evaluate(element => ({ left: element.scrollLeft, width: element.clientWidth, total: element.scrollWidth }));
      assert.equal(start.left, 0); assert.ok(start.total > start.width);
      await images.first().tap(); await page.getByText('Saved ✓').waitFor();
      await strip.evaluate(element => { element.scrollLeft = element.scrollWidth; });
      await images.last().tap(); await page.getByText('Saved ✓').waitFor();
      assert.equal(response().draft.choices.frames.length, 2);
      for (const index of [0, 4]) {
        await strip.evaluate((element, edge) => { element.scrollLeft = edge ? element.scrollWidth : 0; }, index);
        const control = panel.getByRole('checkbox').nth(index).locator('..');
        const box = await control.boundingBox(), image = await images.nth(index).boundingBox();
        assert.ok(box.height >= 44); assert.ok(image.x >= 0 && image.x + image.width <= width);
        await page.screenshot({ path: `/tmp/tra-307-mobile-${width}-${index}.png`, fullPage: true });
      }
    });
  for (const width of [375, 390, 430]) await scenario(`Failed neighboring previews retain touch selection and retry at ${width}px`,
    { width, frameCount: 21, savedNeighbors: true, failPreviews: true }, async ({ page, response, bindings, previewBatches, recoverPreviews, saves }) => {
      await ready(page); const panel = page.getByRole('region', { name: 'Video material review' });
      await panel.getByText('Fixture preview extraction failed.', { exact: false }).waitFor();
      assert.equal(await panel.locator('[data-frame-id] input[type=checkbox]').count(), 21);
      const card = panel.locator(`[data-frame-id="${bindings[1].frameId}"]`);
      assert.equal(await card.getByRole('checkbox').isChecked(), true);
      await card.getByText(bindings[1].frameId, { exact: true }).waitFor();
      await card.getByText(`${bindings[1].timestampMs} ms`, { exact: false }).waitFor();
      await card.getByText('Preview unavailable').waitFor();
      const before = structuredClone(response()); recoverPreviews();
      const retry = card.getByRole('button', { name: 'Retry preview' });
      assert.ok((await retry.boundingBox()).height >= 44); await retry.tap();
      await page.waitForFunction(() => document.querySelectorAll('[data-frame-id] img').length >= 21);
      assert.deepEqual(response(), before); assert.equal(saves.length, 0);
      assert.deepEqual(previewBatches.map(batch => batch.length), [20, 20]);
      await card.getByRole('checkbox').tap(); await page.getByText('Saved ✓').waitFor();
      assert.deepEqual(response().draft.choices.frames, bindings.slice(2));
      const saved = structuredClone(response()); await page.reload(); await ready(page);
      assert.deepEqual(response(), saved);
      assert.equal(await panel.locator('[data-frame-id] input[type=checkbox]').count(), 20);
      assert.deepEqual(previewBatches.map(batch => batch.length), [20, 20, 19]);
      const image = panel.locator('img').last(); await image.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => [...document.querySelectorAll('img')].every(image => image.complete && image.naturalWidth));
      const geometry = await image.evaluate(image => ({ natural: image.naturalWidth / image.naturalHeight,
        rendered: image.getBoundingClientRect().width / image.getBoundingClientRect().height }));
      assert.ok(Math.abs(geometry.natural - geometry.rendered) < 0.01);
      await page.screenshot({ path: `/tmp/tra-308-neighbor-${width}.png`, fullPage: true });
    });
  await scenario('Large neighboring pool queues preview work across rapid deselections',
    { frameCount: 51, savedNeighbors: true, previewDelay: 700 }, async ({ page, response, bindings, previewBatches, previewActivity }) => {
      await ready(page); const panel = page.getByRole('region', { name: 'Video material review' });
      await page.waitForTimeout(50);
      for (const binding of bindings.slice(1, 3)) await panel.locator(`[data-frame-id="${binding.frameId}"]`).getByRole('checkbox').click();
      await page.getByText('Saved ✓').waitFor();
      await page.waitForFunction(() => document.querySelectorAll('[data-frame-id] img').length >= 49);
      assert.equal(previewActivity.peak, 1); assert.ok(previewBatches.every(batch => batch.length <= 24));
      assert.deepEqual(response().draft.choices.frames, bindings.slice(3));
    });
  await scenario('Failed neighboring extraction deselects and refreshes without any successful preview',
    { frameCount: 21, savedNeighbors: true, failPreviews: true }, async ({ page, response, bindings }) => {
      await ready(page); const panel = page.getByRole('region', { name: 'Video material review' });
      await panel.getByText('Fixture preview extraction failed.', { exact: false }).waitFor();
      await panel.locator(`[data-frame-id="${bindings[1].frameId}"]`).getByRole('checkbox').click();
      await page.getByText('Saved ✓').waitFor(); assert.deepEqual(response().draft.choices.frames, bindings.slice(2));
      await page.reload(); await ready(page); assert.deepEqual(response().draft.choices.frames, bindings.slice(2));
      assert.equal(await panel.locator('[data-frame-id] input[type=checkbox]').count(), 20);
    });
  await scenario('Image decode failure retains saved identity and can retry without saving',
    { frameCount: 2, savedNeighbors: true, brokenPreview: true }, async ({ page, response, bindings, recoverPreviews, saves }) => {
      await ready(page); const card = page.getByRole('region', { name: 'Video material review' }).locator(`[data-frame-id="${bindings[1].frameId}"]`);
      await card.getByText('Preview unavailable').waitFor(); assert.equal(await card.getByRole('checkbox').isChecked(), true);
      const before = structuredClone(response()); recoverPreviews(); await card.getByRole('button', { name: 'Retry preview' }).click();
      await card.locator('img').waitFor(); assert.deepEqual(response(), before); assert.equal(saves.length, 0);
    });
  for (const portfolioState of ['PENDING', 'RETRY_REQUIRED']) await scenario(`Large neighboring pool preserves portfolio ${portfolioState} recovery`,
    { frameCount: 51, savedNeighbors: true, portfolioState }, async ({ page, response, previewBatches, saves }) => {
      await ready(page); await page.waitForFunction(() => document.querySelectorAll('[data-frame-id] img').length >= 51);
      assert.deepEqual(previewBatches.map(batch => batch.length), [24, 24, 2]);
      const before = structuredClone(response());
      await page.evaluate(() => localStorage.setItem('tra-creative-portfolio-v1', `portfolio_${'4'.repeat(32)}`)); await page.reload();
      await page.getByRole('region', { name: 'Saved portfolio progress' }).waitFor();
      await page.getByRole('button', { name: portfolioState === 'PENDING' ? 'Resume generation' : 'Retry creative 1', exact: true }).click();
      await page.getByText('Generation complete.').waitFor(); assert.deepEqual(response(), before); assert.equal(saves.length, 0);
    });
  await scenario('Review → Create exact revision/manual frames; refresh and reopen are read-only', {}, async ({ page, calls, submissions }) => {
    await ready(page); assert.equal(await page.locator('input[type=checkbox]').first().isChecked(), true);
    await page.reload(); await ready(page);
    assert.equal(calls.some(([path, method]) => method !== 'GET' && path !== '/api/video/review-sources'), false);
    await page.evaluate(() => history.replaceState(null, '', location.pathname)); await page.reload(); await ready(page);
    assert.equal(await page.getByLabel('Remove fixture.mp4').count(), 1);
    await generateButton(page).dblclick(); await page.getByText('Generation needs attention.').waitFor();
    assert.equal(submissions.length, 1); assert.deepEqual(submissions[0].videoReview, { draftId: id, revision: 'revision-1' });
    assert.deepEqual(submissions[0].sourceAssets, [{ mediaId, role: 'TRA_VIDEO' }]);
  });
  await scenario('Full video inventory survives refresh and explicit removal', {}, async ({ page }) => {
    await ready(page);
    await page.evaluate(() => localStorage.setItem('tra-create-video-ids-v1', JSON.stringify([`media_${'b'.repeat(32)}`, `media_${'9'.repeat(32)}`])));
    await page.reload(); await ready(page); await page.getByLabel('Remove second.mp4').waitFor();
    await page.getByLabel('Remove second.mp4').click(); await page.reload(); await ready(page);
    assert.equal(await page.getByLabel('Remove second.mp4').count(), 0);
  });
  await scenario('Missing reviewed A remains visible while available B is displayed and selected', {
    missingReviewed: true, issue: 'Reviewed video A is unavailable.', inventory: [mediaId, availableB, availableC],
  }, async ({ page, calls, submissions, videoActions, response }) => {
    await ready(page);
    const frozen = structuredClone(response());
    const summary = page.getByRole('region', { name: 'Saved video review' });
    await summary.getByText(segment.text, { exact: true }).waitFor();
    const assertFrozen = async () => {
      assert.equal(await summary.getAttribute('data-review-id'), id);
      assert.equal(await summary.getAttribute('data-review-revision'), frozen.revision);
      assert.equal(await summary.getAttribute('data-video-id'), mediaId);
      assert.equal(await summary.locator('[data-frame-id]').getAttribute('data-frame-id'), frame.frameId);
      assert.equal(await summary.getByText('Selected frame at 00:01', { exact: true }).isVisible(), true);
      assert.equal(await summary.getByText(segment.text, { exact: true }).isVisible(), true);
      assert.equal(await generateButton(page).isDisabled(), true);
      assert.deepEqual(response(), frozen);
    };
    await assertFrozen();
    const picker = page.getByRole('combobox').filter({ has: page.locator(`option[value="${availableB}"]`) });
    assert.equal(await picker.inputValue(), availableB);
    await picker.selectOption(availableC); await page.getByText('Video material ready').waitFor();
    await assertFrozen();
    await picker.selectOption(availableB); await page.getByText('Video material ready').waitFor();
    await assertFrozen();
    await page.getByRole('button', { name: 'Reload saved review' }).click(); await assertFrozen();
    assert.equal(await page.getByLabel('Remove second.mp4').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Remove unavailable videos' }).count(), 1);
    assert.equal(calls.some(([path, method]) => path === '/api/video/review-selection' && method !== 'GET'), false);
    assert.deepEqual(submissions, []); assert.deepEqual(videoActions, []);
    await page.getByRole('button', { name: 'Remove unavailable videos' }).click();
    await summary.waitFor({ state: 'detached' });
    assert.equal(response().draft.choices.video, null);
    assert.equal(await page.getByLabel('Remove second.mp4').count(), 1);
    assert.equal(await page.getByLabel('Remove third.mp4').count(), 1);
  });
  for (const frames of [null, []]) await scenario(`Automatic frame mode ${JSON.stringify(frames)}`, { frames }, async ({ page, submissions, response }) => {
    await ready(page); assert.equal(await page.locator('input[type=checkbox]').first().isChecked(), false);
    await generateButton(page).click(); await page.getByText('Generation needs attention.').waitFor();
    assert.deepEqual(response().draft.choices.frames, frames); assert.equal(submissions.length, 1);
  });
  await scenario('Manual selection save uses settled revision; Profile navigation preserves choices', { frames: null }, async ({ page, submissions, response }) => {
    await ready(page); await page.locator('input[type=checkbox]').first().check(); await page.getByText('Saved ✓').waitFor();
    await page.getByRole('navigation', { name: 'Creative workspace' }).getByRole('button').filter({ hasText: 'Company' }).click(); await page.getByRole('navigation', { name: 'Creative workspace' }).getByRole('button').filter({ hasText: 'Create' }).click();
    assert.equal(await page.locator('input[type=checkbox]').first().isChecked(), true);
    assert.deepEqual(response().draft.choices.frames, [frame]);
    await generateButton(page).click(); await page.getByText('Generation needs attention.').waitFor();
    assert.equal(submissions[0].videoReview.revision, 'revision-2');
  });
  await scenario('Changed Profile blocks Create until explicit update', { profile: true }, async ({ page, response }) => {
    await ready(page); await page.getByRole('navigation', { name: 'Creative workspace' }).getByRole('button').filter({ hasText: 'Company' }).click();
    await page.getByLabel('Services & offers', { exact: false }).fill('Updated offer.');
    await page.getByRole('navigation', { name: 'Creative workspace' }).getByRole('button').filter({ hasText: 'Create' }).click();
    assert.equal(await generateButton(page).isDisabled(), true);
    await page.getByRole('button', { name: 'Use current Company Profile' }).click();
    await page.waitForFunction(() => !document.body.textContent.includes('Company Profile changed.'));
    assert.equal(response().draft.choices.companyProfile.knowledgeBase.servicesOffers, 'Updated offer.');
    assert.deepEqual(response().draft.choices.frames, [frame]);
  });
  for (const phase of ['FAILED', 'RETRY_REQUIRED', 'OBSERVING']) await scenario(`Preparation ${phase} and explicit recovery`, { phase }, async ({ page, videoActions }) => {
    await page.getByRole('region', { name: 'Video material review' }).waitFor();
    if (phase === 'FAILED') { await page.getByText('Preparation failed: Fixture preparation failed.').waitFor(); assert.deepEqual(videoActions, []); }
    else { await page.getByRole('button', { name: phase === 'RETRY_REQUIRED' ? 'Retry video preparation' : 'Resume video preparation' }).click();
      await page.getByText('Video material ready').waitFor(); assert.deepEqual(videoActions, [phase === 'RETRY_REQUIRED' ? 'RETRY' : 'ADVANCE']); }
  });
  for (const options of [{ issue: 'Source hash changed.' }, { missingMedia: true }, { missingDraft: true }])
    await scenario(`Reject ${JSON.stringify(options)}`, options, async ({ page, submissions }) => {
      await page.locator('textarea').fill('Create concepts.'); assert.equal(await generateButton(page).isDisabled(), true); assert.deepEqual(submissions, []);
      if (options.missingDraft) {
        await page.getByRole('button', { name: 'Reload saved review' }).click();
        await page.waitForFunction(() => !document.body.textContent.includes('Saving…'));
        assert.equal(await generateButton(page).isDisabled(), true);
      }
      if (options.missingMedia) {
        await page.getByRole('region', { name: 'Saved video review' }).getByText(segment.text, { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Remove unavailable videos' }).click();
      }
    });
  await scenario('Stale revision rejected at Create submission with direct reload recovery', { invalidRevision: true }, async ({ page, submissions, calls }) => {
    await ready(page); await generateButton(page).click();
    await page.getByRole('button', { name: 'Reload saved review' }).waitFor();
    assert.equal(submissions.length, 1);
    assert.equal(calls.some(([path, method]) => path === '/api/creatives/portfolios' && method === 'PATCH'), false);
    const loads = calls.filter(([path, method]) => path === '/api/video/review-selection' && method === 'GET').length;
    await page.getByRole('button', { name: 'Reload saved review' }).click();
    await page.waitForFunction(() => !document.body.textContent.includes('Saving…'));
    assert.equal(calls.filter(([path, method]) => path === '/api/video/review-selection' && method === 'GET').length, loads + 1);
  });
  for (const portfolioState of ['PENDING', 'RETRY_REQUIRED', 'SAVED']) await scenario(`Saved portfolio ${portfolioState}`, { portfolioState }, async ({ page, calls }) => {
    await page.evaluate(() => localStorage.setItem('tra-creative-portfolio-v1', `portfolio_${'4'.repeat(32)}`)); await page.reload();
    await page.getByRole('region', { name: 'Saved portfolio progress' }).waitFor();
    assert.equal(calls.filter(([path, method]) => path === '/api/creatives/portfolios' && method !== 'GET').length, 0);
    if (portfolioState === 'PENDING') { await page.getByRole('button', { name: 'Resume generation' }).click(); await page.getByText('Generation complete.').waitFor(); }
    else if (portfolioState === 'RETRY_REQUIRED') { await page.getByRole('button', { name: 'Retry creative 1', exact: true }).click(); await page.getByText('Generation complete.').waitFor(); }
    else await page.getByText('Generation complete.').waitFor();
  });
  console.log(`${results.length} offline Chromium scenarios passed.`);
} finally { await browser.close(); await server.close(); }
