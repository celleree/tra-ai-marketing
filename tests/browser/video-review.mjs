import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

// Use an already installed Playwright package; do not add a production dependency or fetch providers.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({ root, configFile: false, cacheDir: '/tmp/tra-slice4-vite-cache',
  resolve: { alias: { '@': root, 'node:crypto': root + 'node_modules/next/dist/compiled/crypto-browserify/index.js', ...Object.fromEntries(['buffer', 'events', 'stream', 'string_decoder', 'util', 'vm'].map(name => [name, require.resolve(root + 'node_modules/next/dist/compiled/' + ({ stream: 'stream-browserify', vm: 'vm-browserify' }[name] ?? name))])) } }, oxc: { jsx: { runtime: 'automatic' } },
  server: { host: '127.0.0.1', port: 0 }, define: { 'process.env': '{}', __dirname: JSON.stringify('/'), 'process.browser': 'true', global: 'globalThis' } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/video-review.html`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}) });
const id = `review_${'a'.repeat(32)}`, mediaId = `media_${'b'.repeat(32)}`;
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
const results = [];
async function scenario(name, options, run) {
  const context = await browser.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = [], calls = [], submissions = [], videoActions = [];
  page.on('pageerror', error => errors.push(error.message));
  let choices = { video, frames: options.frames === undefined ? [frame] : options.frames, claims: [claim], companyProfile: options.profile ? profile : null };
  let revision = 'revision-1', phase = options.phase ?? 'COMPLETE', issue = options.issue;
  const response = () => ({ draft: { id, version: 1, artifactType: 'VIDEO_REVIEW_DRAFT', providerEligible: false,
    choices, claimSnapshots: [{ reference: claim, wording: segment.text, context: { type: 'VIDEO_TRANSCRIPT', segments: [segment] } }], updatedAtMs: 1 },
    revision, issues: issue ? [{ source: 'VIDEO', message: issue }] : [], transcriptContext: null, profileSource: null });
  await context.addInitScript(({ id, mediaId, profile, hasProfile }) => {
    if (sessionStorage.getItem('video-review-fixture-seeded')) return;
    sessionStorage.setItem('video-review-fixture-seeded', 'true');
    localStorage.setItem('tra-video-review-draft-v1', id);
    localStorage.setItem('tra-create-video-ids-v1', JSON.stringify([mediaId]));
    if (hasProfile) localStorage.setItem('tra-company-profile-v2', JSON.stringify({ websiteUrl: '', brandGuidelines: {}, guardrails: {}, ...profile }));
  }, { id, mediaId, profile, hasProfile: options.profile });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, body = request.postDataJSON();
    calls.push([path, request.method()]);
    let value = {}, status = 200;
    if (path === '/api/video/review-selection') {
      if (options.missingDraft) { status = 404; value = { error: 'Review draft was not found.' }; }
      else if (options.invalidRevision) { status = 409; value = { error: 'Review draft changed. Reload before saving.' }; }
      else { if (request.method() === 'POST') { choices = body.choices; revision = 'revision-2'; issue = undefined; } value = response(); }
    } else if (path === '/api/video/intelligence/jobs') {
      if (request.method() === 'POST') { videoActions.push(body.action); phase = 'COMPLETE'; value = { phase, locator: video.locator, busy: false }; }
      else if (options.missingMedia) { status = 404; value = { error: 'Stored video is missing.' }; }
      else { const requestedId = new URL(request.url()).searchParams.get('mediaId');
        value = { source: { ...media, id: requestedId, originalName: requestedId === mediaId ? 'fixture.mp4' : 'second.mp4' }, locator: video.locator, status: { phase, locator: video.locator, busy: false } }; }
    } else if (path === '/api/video/intelligence/library') value = {};
    else if (path === '/api/video/review-sources') {
      if (request.method() === 'POST') value = { statements: [], companyProfile: body.companyProfile };
      else if (options.missingMedia) { status = 404; value = { error: 'Stored video is missing.' }; }
      else value = { source: media, status: { phase, locator: video.locator, completedRepresentatives: 1, totalRepresentatives: 1, busy: false,
        failure: { message: 'Fixture preparation failed.' }, retry: { message: 'Uncertain prior attempt.' } },
        review: phase !== 'COMPLETE' ? null : { video, frameBindings: [frame], onScreenStatements: [], library: { transcript: { segments: [segment] },
          representativeFrames: [{ ...frame, id: frame.frameId, thumbnailDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l8AAAAASUVORK5CYII=' }] } } };
    } else if (path === '/api/creatives/portfolios') {
      if (request.method() === 'POST') submissions.push(body);
      const state = request.method() === 'GET' ? options.portfolioState ?? 'BLOCKED' : request.method() === 'PATCH' ? 'SAVED' : 'BLOCKED';
      value = { job: job(state), creatives: [] };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  });
  // Abort every external request; the harness never reaches an auth, storage or provider service.
  await page.route(/^https:\/\//, route => route.abort());
  try {
    await page.goto(url);
    await page.getByRole('button', { name: 'Generate creatives', exact: true }).waitFor();
    await page.waitForFunction(() => !document.body.textContent.includes('Restoring saved videos'));
    await run({ page, calls, submissions, videoActions, response });
    assert.deepEqual(errors, [], 'Browser runtime errors');
    results.push(name); console.log(`PASS ${name}`);
  } finally { await context.close(); }
}
const generateButton = page => page.getByRole('button', { name: 'Generate creatives', exact: true });
const ready = async page => { await page.locator('textarea').fill('Create four distinct concepts.'); await page.getByText('Video material ready').waitFor(); };
try {
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
  for (const options of [{ issue: 'Source hash changed.' }, { missingMedia: true }, { missingDraft: true }, { invalidRevision: true }])
    await scenario(`Reject ${JSON.stringify(options)}`, options, async ({ page, submissions }) => {
      await page.locator('textarea').fill('Create concepts.'); assert.equal(await generateButton(page).isDisabled(), true); assert.deepEqual(submissions, []);
      if (options.missingDraft || options.invalidRevision) {
        await page.getByRole('button', { name: 'Reload saved review' }).click();
        await page.waitForFunction(() => !document.body.textContent.includes('Saving…'));
        assert.equal(await generateButton(page).isDisabled(), true);
      }
      if (options.missingMedia) {
        await page.getByText('Saved selected material').click(); await page.getByText(segment.text, { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Remove unavailable videos' }).click();
      }
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
