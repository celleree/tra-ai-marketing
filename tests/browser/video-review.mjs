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
const server = await createServer({ root, configFile: false, cacheDir: root + 'node_modules/.vite-browser',
  plugins: [{ name: 'app-styles', transformIndexHtml: () => [
    { tag: 'meta', attrs: { name: 'viewport', content: 'width=device-width, initial-scale=1' }, injectTo: 'head' },
    ...['/app/globals.css', '/app/ui-sweep.css'].map(href => ({ tag: 'link', attrs: { rel: 'stylesheet', href }, injectTo: 'head' }))] }],
  resolve: { alias: { '@': root, 'node:crypto': root + 'node_modules/next/dist/compiled/crypto-browserify/index.js', ...Object.fromEntries(['buffer', 'events', 'stream', 'string_decoder', 'util', 'vm'].map(name => [name, require.resolve(root + 'node_modules/next/dist/compiled/' + ({ stream: 'stream-browserify', vm: 'vm-browserify' }[name] ?? name))])) } }, oxc: { jsx: { runtime: 'automatic' } },
  server: { host: '127.0.0.1', port: 0 }, define: { 'process.env': '{}', __dirname: JSON.stringify('/'), 'process.browser': 'true', global: 'globalThis' } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/video-review.html`;
const browser = await browserTypes[browserName].launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_PATH && browserName === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}) });
const id = `review_${'a'.repeat(32)}`, mediaId = `media_${'b'.repeat(32)}`;
const availableB = `media_${'9'.repeat(32)}`, availableC = `media_${'8'.repeat(32)}`;
const layoutMediaId = `media_${'1'.repeat(32)}`;
const video = { locator: { version: 1, sourceVideoMediaId: mediaId, sourceVideoContentHash: 'c'.repeat(64), analyzerFingerprintSha256: 'd'.repeat(64) },
  libraryId: `video-library:${'e'.repeat(64)}`, librarySha256: 'f'.repeat(64), preparationSha256: '1'.repeat(64) };
const frame = { frameId: `video-frame:${'2'.repeat(64)}`, representativeFrameId: `video-frame:${'2'.repeat(64)}`, candidateIndex: 0, timestampMs: 1000, frameSha256: '3'.repeat(64) };
const media = { id: mediaId, fileName: 'fixture.mp4', originalName: 'fixture.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', size: 42, url: '/fixture.mp4' };
const profile = { knowledgeBase: { servicesOffers: 'Saved consultation offer.' } };
const claim = { type: 'VIDEO_TRANSCRIPT', startSegmentIndex: 0, endSegmentIndex: 0 };
const segment = { segmentIndex: 0, startMs: 0, endMs: 2000, text: 'Exact saved video wording.' };
const job = (status = 'BLOCKED', count = 4) => ({ id: `portfolio_${'4'.repeat(32)}`, requestedCount: count, planReady: true, planningPhase: 'READY_TO_RENDER',
  planningCheckpoint: 0, planningError: null, lease: null, slots: Array.from({ length: count }, (_, i) => ({ index: i + 1,
    creativeId: `creative_${String(i + 5).repeat(32)}`, status, ...(status === 'BLOCKED' ? { error: 'Offline fixture stop.' } : {}) })) });
const previewSourceId = 'portfolio_6c97da21ad5d8ea9a2381ecba2284539';
const previewNewId = 'portfolio_346c546916ed361d9d4c58ced212d512';
const thumbnails = await Promise.all([[180, 320], [320, 180]].map(async ([width, height]) =>
  'data:image/png;base64,' + (await sharp(Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#cddbe8"/><text x="8" y="18">TOP CAPTION</text><text x="8" y="${height - 8}">BOTTOM CAPTION</text></svg>`)).png().toBuffer()).toString('base64')));
const results = [];
async function scenario(name, options, run) {
  if (process.env.VIDEO_REVIEW_SCENARIO && !name.includes(process.env.VIDEO_REVIEW_SCENARIO)) return;
  if (process.env.VIDEO_REVIEW_SCENARIO && !name.includes(process.env.VIDEO_REVIEW_SCENARIO)) return;
  const context = await browser.newContext(options.width ? { viewport: { width: options.width, height: 900 }, isMobile: options.width < 700, hasTouch: options.width < 700 } : {});
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = [], calls = [], submissions = [], videoActions = [];
  const accessDenials = { ...options.accessDenials };
  const segments = Array.from({ length: options.statementCount ?? 1 }, (_, index) => ({ ...segment, segmentIndex: index,
    text: options.longStatements ? `Saved consultation wording ${index + 1}. ${'A detailed statement with several useful lines of text. '.repeat(6)} ${'reference_'.repeat(18)}` : segment.text }));
  let releaseSourceReads = () => {};
  let releasePortfolioAdvance = () => {}, portfolioLoadFailure = 0, caseRecovered = false;
  const portfolioAdvanceGate = options.holdPortfolioAdvance ? new Promise(resolve => { releasePortfolioAdvance = resolve; }) : null;
  const sourceReadGate = options.holdSourceReads || options.holdSourceReadPaths ? new Promise(resolve => { releaseSourceReads = resolve; }) : null;
  page.on('pageerror', error => errors.push(error.message));
  let choices = { video, frames: options.frames === undefined ? [frame] : options.frames, claims: [claim], companyProfile: options.profile ? profile : null };
  const bindings = Array.from({ length: options.frameCount ?? 1 }, (_, index) => index ? { ...frame,
    frameId: `video-frame:${String(index + 4).repeat(64)}`, candidateIndex: index, timestampMs: (index + 1) * 1000 } : frame);
  const onScreen = options.compactStatements ? bindings.slice(0, 2).map(binding => ({
    reference: { type: 'VIDEO_ON_SCREEN', frame: binding, statementIndex: 0 }, wording: 'Exact repeated $100 statement.',
    context: { type: 'VIDEO_ON_SCREEN', observation: { sceneType: 'PERSON', summary: 'Source observation', composition: 'Portrait',
      visibleText: ['Exact repeated $100 statement.'], topics: [], uncertainties: ['Unverified observation.'] } } })) : [];
  if (options.compactStatements) choices.claims = [onScreen[1].reference];
  if (options.savedNeighbors) choices.frames = bindings.slice(1);
  if (options.selectedFrameCount) choices.frames = bindings.slice(0, options.selectedFrameCount);
  if (options.longStatements) choices.claims = segments.map(item => ({ ...claim, startSegmentIndex: item.segmentIndex, endSegmentIndex: item.segmentIndex }));
  const previewBatches = [], previewActivity = { active: 0, peak: 0 }; let previewFailure = Boolean(options.failPreviews), brokenPreview = Boolean(options.brokenPreview);
  const saves = []; let failure = 0, loadFailure = 0, sourceFailure = 0, revisionNumber = 1;
  let caseApplied = false, cropStage = 'failed';
  let revision = 'revision-1', phase = options.phase ?? 'COMPLETE', issue = options.issue;
  const response = () => ({ draft: { id, version: 1, artifactType: 'VIDEO_REVIEW_DRAFT', providerEligible: false,
    choices, claimSnapshots: segments.filter(item => choices.claims?.some(reference => reference.type === 'VIDEO_TRANSCRIPT' && reference.startSegmentIndex === item.segmentIndex))
      .map(item => ({ reference: { ...claim, startSegmentIndex: item.segmentIndex, endSegmentIndex: item.segmentIndex }, wording: item.text, context: { type: 'VIDEO_TRANSCRIPT', segments: [item] } })), updatedAtMs: 1 },
    revision, issues: issue ? [{ source: 'VIDEO', message: issue }] : [], transcriptContext: null, profileSource: null });
  await context.addInitScript(({ id, inventory, profile, hasProfile, noLogo }) => {
    if (sessionStorage.getItem('video-review-fixture-seeded')) return;
    sessionStorage.setItem('video-review-fixture-seeded', 'true');
    if (id) localStorage.setItem('tax-marketing-studio:video-review-draft:v1', id);
    localStorage.setItem('tax-marketing-studio-create-video-ids-v1', JSON.stringify(inventory));
    localStorage.setItem('tax-marketing-studio:company-profile:v1', JSON.stringify({ websiteUrl: '', knowledgeBase: {}, guardrails: {}, ...(hasProfile ? profile : {}),
      brandGuidelines: noLogo ? {} : { logo: '/api/media/files/media_77777777777777777777777777777777.png' } }));
  }, { id: options.noSavedReview ? null : id, inventory: options.inventory ?? [mediaId], profile, hasProfile: options.profile, noLogo: options.noLogo });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, body = request.postDataJSON();
    calls.push([path, request.method()]);
    if (accessDenials[request.method() + ' ' + path]) {
      await route.fulfill({ status: accessDenials[request.method() + ' ' + path], contentType: options.htmlDenial ? 'text/html' : 'application/json',
        body: options.htmlDenial ? '<html><body>Sign in required.</body></html>' : JSON.stringify({ error: 'Sign in required.' }) }); return;
    }
    if (sourceReadGate && request.method() === 'GET'
      && (options.holdSourceReadPaths ?? ['/api/video/intelligence/jobs', '/api/references']).includes(path)) {
      await sourceReadGate;
      if (request.failure()) return;
    }
    const requestedId = new URL(request.url()).searchParams.get('mediaId') ?? mediaId;
    const missing = options.missingMedia || (options.missingReviewed && requestedId === mediaId);
    const currentVideo = { ...video, locator: { ...video.locator, sourceVideoMediaId: requestedId } };
    const currentMedia = { ...media, id: requestedId, originalName: requestedId === mediaId ? options.videoName ?? 'fixture.mp4' : requestedId === availableB ? 'second.mp4' : 'third.mp4' };
    let value = {}, status = 200, isPreview = false;
    if(options.logoOverlay && path.startsWith('/api/media/files/')) {await route.fulfill({status:200,contentType:'image/png',body:Buffer.from(thumbnails[0].split(',')[1],'base64')});return;}
    if(options.logoOverlay && path===`/api/creatives/creative_${'a'.repeat(32)}/logo`) {
      assert.equal(request.method(),'POST');submissions.push({body,key:request.headers()['idempotency-key']});
      assert.deepEqual(body,{logoMediaId:`media_${'7'.repeat(32)}`,anchor:'top-left'});
      value={creative:{id:`creative_${'c'.repeat(32)}`,image:{url:thumbnails[1]},identity:{parentCreativeId:`creative_${'a'.repeat(32)}`},generationProvenance:{logoOverlaySource:{mediaId:body.logoMediaId},revision:{logoOverlay:{version:1,anchor:body.anchor,outputSha256:'d'.repeat(64)}}}}};
    } else if (path === '/api/creatives/portfolios/portrait-diagnostic') {
      assert.equal(request.method(), 'GET'); value = { slotIndex: 2, timestampMs: 21333, crop: { left: 0, top: 0, width: 600, height: 330 },
        portfolioId: `portfolio_${'4'.repeat(32)}`, frameIdentity: { caseFrameId: frame.frameId, selectedFrameId: frame.frameId, caseTimestampMs: 21333, selectedCandidateIndex: 66 },
        cropDecision: { version: 2, status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 450, overlayDepthPermille: 400 },
        originalDimensions: { width: 600, height: 600 }, originalPng: { dataUrl: thumbnails[0], width: 600, height: 600 }, originalPreviewError: '',
        assessmentStatus: 'COMPLETE', assessment: { eyes: 'UNCERTAIN', sourceOverlay: { version: 2, status: 'UNSAFE' }, observableReason: 'Visible mark remains.' },
        portraitPin: {sourcePngSha256:'a'.repeat(64),providerPngSha256:'b'.repeat(64)}, sourceVideoContentHash:video.locator.sourceVideoContentHash, recoveryEligible:Boolean(options.revisedCrop && cropStage==='failed'),
        failedChecks: ['eyes', 'sourceOverlay'], png: { dataUrl: thumbnails[0], width: 600, height: 330, matchesPinned: true }, previewError: '' };
      if(options.revisedCrop && new URL(request.url()).searchParams.has('edge')) {
        assert.equal(new URL(request.url()).searchParams.get('removePermille'),'437');
        value.proposed={dataUrl:thumbnails[0],width:360,height:360,state:{sourcePngSha256:'a'.repeat(64),providerPngSha256:'c'.repeat(64)},overlay:{version:2,status:'EDGE_CROP',edge:'BOTTOM',removePermille:437,overlayDepthPermille:437}};
      }
    } else if (path === '/api/creatives/portfolios/case-amendment') {
      const caseClaims = ['My debt went from $42,000 to $250. This was my individual result.', 'TRA reduced what I owed by 78%. I felt relieved about my case.'];
      const caseFrames = [frame.frameId, `video-frame:${'9'.repeat(64)}`];
      if (request.method() === 'GET') value = caseApplied ? { applied: true } : { attributionNotice: 'Cached observations do not verify speaker identity. Confirm the statement belongs to this person.',
        ...(options.plannedCases ? { plannedPairs: caseClaims.map((_, claimIndex) => ({ slotIndex: claimIndex + 1, claimIndex, frameId: '', attributionConfirmed: false })) } : {}),
        slots: [{ index: 1 }, { index: 2 }], claims: caseClaims.map((wording, claimIndex) => ({ claimIndex, wording,
          frames: [{ frameId: caseFrames[claimIndex], timestampMs: claimIndex ? 12000 : 6000, observationIsExactFrame: true,
            observation: { summary: claimIndex ? 'Bearded person outdoors' : 'Bald person indoors', uncertainties: [] } }] })) };
      else if (request.method() === 'POST') {
        assert.deepEqual(body.pairs.map(pair => [pair.claimIndex, pair.frameId]), [[0, caseFrames[0]], [1, caseFrames[1]]]);
        value = { amendment: { version: 1, intent: 'VIDEO_CASE_STUDY', pairs: body.pairs },
          creatives: caseClaims.map((shortSupport, index) => ({ index: index + 1, imageCopy: { shortSupport } })),
          providerOperations: { maximumFrameAssessments: 2, maximumPrimaryImages: 2 } };
      } else { assert.ok(body.amendment.pairs.every(pair => pair.attributionConfirmed)); caseApplied = true; value = { applied: true }; }
    } else if (path === '/api/video/review-selection') {
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
        review: phase !== 'COMPLETE' ? null : { video: currentVideo, frameBindings: bindings, onScreenStatements: onScreen, library: { transcript: { segments },
          representativeFrames: bindings.slice(0, options.representativeCount ?? (options.savedNeighbors ? 1 : bindings.length)).map((binding, index) => ({ ...binding, id: binding.frameId, thumbnailDataUrl: thumbnails[index % 2] })) } } };
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
    } else if (path === '/api/references') {
      value = { items: options.linkedLayout ? [{ id: layoutMediaId, fileName: `${layoutMediaId}.png`, originalName: 'fixture-layout.png',
        mimeType: 'image/png', size: 42, url: thumbnails[0], referenceType: options.wrongLayoutType ? 'tra' : 'layout' }] : [] };
    } else if (path === '/api/creatives/portfolios') {
      if (request.method() === 'POST') { submissions.push(body); if (options.generationDelay) await new Promise(resolve => setTimeout(resolve, options.generationDelay)); }
      const state = request.method() === 'GET' ? options.portfolioState ?? 'BLOCKED' : request.method() === 'PATCH' ? 'SAVED' : 'BLOCKED';
      if (options.revisedCrop) {
        if(request.method()==='PATCH') {
          submissions.push(body);assert.equal(body.slotIndex,2);assert.notEqual(body.action,'advance');assert.notEqual(body.action,'retry');
          if(body.action==='recover-bound-case-crop') {assert.equal(cropStage,'failed');assert.equal(body.revision.timestampMs,21333);assert.equal(body.revision.frameId,frame.frameId);assert.equal(body.revision.sourceVideoContentHash,video.locator.sourceVideoContentHash);assert.equal(body.revision.previousProviderPngSha256,'b'.repeat(64));assert.equal(body.revision.revisedProviderPngSha256,'c'.repeat(64));cropStage='prepared';}
          else if(body.action==='assess-bound-case-crop'){assert.equal(cropStage,'prepared');assert.equal(body.approved,true);cropStage='passed';}
          else if(body.action==='generate-bound-case-crop'){assert.equal(cropStage,'passed');assert.equal(body.approved,true);cropStage='saved';}
          else assert.fail('Unexpected recovery command');
        }
        const savedJob=job(cropStage==='failed'?'RETRY_REQUIRED':cropStage==='saved'?'SAVED':'PENDING',2);savedJob.slots[0].status='SAVED';
        savedJob.slots[1].videoSelection={version:2,providerPortrait:{verified:cropStage==='passed'||cropStage==='saved'},...(cropStage==='failed'?{}:{portraitCropRevision:{assessmentAttempted:cropStage==='passed'||cropStage==='saved',imageAuthorized:cropStage==='saved'}})};
        if(cropStage==='failed')savedJob.slots[1].error='The actual retained portrait PNG did not pass human or overlay checks. Saved creatives remain available.';
        value={job:savedJob,creatives:[]};
      } else if (options.portraitDiagnostic) {
        const savedJob = job('RETRY_REQUIRED', 2); savedJob.slots[0].status = 'SAVED';
        savedJob.slots[1].error = 'The actual retained portrait PNG did not pass human or overlay checks. Saved creatives remain available.';
        if (!options.noPortraitPin) savedJob.slots[1].videoSelection = { version: 2, providerPortrait: { verified: false } };
        if (options.portraitLease) savedJob.lease = { slotIndex: 2, expiresAtMs: Date.now() + 60_000 };
        value = { job: savedJob, creatives: [] };
      } else if (options.caseRecovery) {
        if (request.method() === 'PATCH') { assert.equal(body.action, 'recover-bound-case-crop'); assert.equal(body.slotIndex, 2); caseRecovered = true; }
        const savedJob = job('PENDING', 2); savedJob.slots[0].status = 'SAVED';
        savedJob.slots[1] = { ...savedJob.slots[1], status: caseRecovered ? 'PENDING' : 'BLOCKED',
          ...(caseRecovered ? { boundCaseCropRecovery: { version: 1, previousError: 'No suitable human frame was found.' } }
            : { error: 'No suitable human frame was found.' }) };
        value = { job: savedJob, creatives: [], ...(!caseRecovered ? { boundCaseCropRecoverySlot: 2 } : {}) };
      } else if (options.casePortfolio) value = { job: { ...job('PENDING', 2), videoPreparation: { total: 2, completed: 2, phase: 'COMPLETE', busy: false } }, creatives: [] };
      else if (portfolioLoadFailure && request.method() === 'GET') { status = portfolioLoadFailure; value = { error: 'Sign in required.' }; }
      else if (options.pausedRecovery) {
        if (request.method() === 'PATCH') await portfolioAdvanceGate;
        value = { job: { ...job('PENDING', 2), ...(request.method() === 'POST' ? { planReady: false, planningPhase: 'INITIAL_PLAN' } : {}) }, creatives: [] };
      } else if (options.previewInitialization) {
        assert.notEqual(request.method(), 'PATCH', 'Initialization or refresh must not advance providers');
        const initializing = request.method() === 'POST';
        if (initializing) assert.deepEqual(body, { action: 'initialize-approved-preview', sourcePortfolioId: previewSourceId });
        const newRun = initializing || new URL(request.url()).searchParams.get('id') === previewNewId;
        if (initializing && options.initializationDenied) { status = 409; value = { error: 'Fixture initialization denied.' }; }
        else { status = initializing ? 201 : 200;
          value = { job: { ...job('PENDING', 2), id: newRun ? previewNewId : previewSourceId,
            planReady: false, planningPhase: 'INITIAL_PLAN',
            ...(newRun ? {} : { planningError: 'Prior frame assessment failed.', previewAcceptanceError: 'Old approved run remains stopped.' }) },
          creatives: [], previewOmitBrandLogo: true, ...(newRun ? { previewPreparationApproved: true } : { previewInitializationAvailable: true }) };
        }
      } else if (options.invalidRevision && request.method() === 'POST') { status = 409; value = { error: 'Review draft changed. Reload the saved review before generating.' }; }
      else value = options.cachedPreflight ? {
        job: { ...job('PENDING', 2), planReady: false, planningPhase: 'INITIAL_PLAN' }, creatives: [],
        preflightReady: true, previewOmitBrandLogo: true,
      } : { job: job(state), creatives: [] };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (isPreview) previewActivity.active--;
  });
  // Abort every external request; the harness never reaches an auth, storage or provider service.
  await page.route(/^https:\/\//, route => route.abort());
  try {
    const target = new URL(options.logoOverlay ? '/tests/browser/logo-overlay.html' : url, url);
    if (options.linkedVideo) target.searchParams.set('videoMediaId', options.linkedVideo);
    if (options.linkedLayout) target.searchParams.set('layoutMediaId', options.linkedLayout);
    if (options.acceptancePreview) target.searchParams.set('acceptancePreview', '1');
    if (options.caseAmendment) target.searchParams.set('caseAmendment', '1');
    if (options.casePortfolio) target.searchParams.set('portfolio', `portfolio_${'4'.repeat(32)}`);
    if (options.previewInitialization) target.searchParams.set('portfolio', previewSourceId);
    if (options.savedPortfolio) { target.searchParams.set('portfolio', job().id); target.searchParams.set('review', id); }
    await page.goto(target.href);
    if(options.logoOverlay) await page.getByRole('button',{name:'Add saved logo without AI',exact:true}).waitFor();
    else await page.getByRole('button', { name: options.caseAmendment ? 'Preview amendment without generating' : 'Generate creatives', exact: true }).waitFor();
    if (!options.runWhilePending) await page.waitForFunction(() => !document.body.textContent.includes('Restoring saved videos'));
    await run({ page, calls, submissions, videoActions, response, bindings, saves, previewBatches, previewActivity, releaseSourceReads, releasePortfolioAdvance,
      denyAccess: (key, status) => { accessDenials[key] = status; },
      denyPortfolioLoads: status => { portfolioLoadFailure = status; }, recoverPreviews: () => { previewFailure = false; brokenPreview = false; }, failNext: status => { failure = status; }, denyLoads: status => { loadFailure = status; }, failSource: status => { sourceFailure = status; } });
    assert.deepEqual(errors, [], 'Browser runtime errors');
    results.push(name); console.log(`PASS ${name}`);
  } finally { releaseSourceReads(); releasePortfolioAdvance(); await context.close(); }
}
const generateButton = page => page.getByRole('button', { name: 'Generate creatives', exact: true });
const ready = async page => { await page.locator('textarea').fill('Create four distinct concepts.'); await page.getByText('Video material ready').waitFor(); };
try {
  for(const denial of [false,true]) await scenario(`Original logo-only version saves without generation${denial?' after sign-in denial':''}`,{logoOverlay:true,width:375,...(denial?{accessDenials:{[`POST /api/creatives/creative_${'a'.repeat(32)}/logo`]:401}}:{})},async({page,calls,submissions})=>{
    await page.getByRole('button',{name:'Add saved logo without AI',exact:true}).click();
    await page.getByRole('img',{name:'Saved company logo',exact:true}).waitFor();
    await page.getByLabel('Logo position').selectOption('top-left');
    assert.equal(submissions.length,0);await page.getByRole('button',{name:'Save logo-only version',exact:true}).click();
    if(denial){await page.getByText('Sign in to save this logo-only version. The original is unchanged.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Save logo-only version',exact:true}).isDisabled(),true);assert.equal(submissions.length,0);}
    else{await page.getByText('Logo-only version saved. Original preserved.',{exact:true}).waitFor();await page.getByRole('img',{name:'New creative with company logo',exact:true}).waitFor();assert.equal(submissions.length,1);assert.match(submissions[0].key,/^[a-f0-9-]{36}$/);}
    assert.equal(calls.filter(([path,method])=>method==='POST'&&path.endsWith('/revise')).length,0);
    assert.equal(calls.filter(([path])=>path==='/api/creatives/portfolios').length,0);
    const bounds=await page.evaluate(()=>({body:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(bounds.body<=bounds.viewport+1);
  });
  await scenario('Compact observations retain duplicate timestamps and mixed selections after mobile reload', { compactStatements: true, frameCount: 2, width: 375 }, async ({ page, response }) => {
    const row = page.getByRole('checkbox', { name: 'Exact repeated $100 statement. 00:01, 00:02', exact: true });
    await row.waitFor(); assert.equal(await row.evaluate(input => input.indeterminate), true);
    assert.equal(response().draft.choices.claims.length, 1);
    await row.click(); await page.waitForFunction(() => !document.body.textContent.includes('Saving review'));
    await page.reload(); await row.waitFor(); assert.equal(await row.isChecked(), true);
    assert.equal(response().draft.choices.claims.length, 2);
    assert.equal(await page.getByText('On-screen video text', { exact: false }).count(), 0);
    const bounds = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    assert.ok(bounds.width <= bounds.viewport + 1);
  });
  for (const denial of [false, true]) await scenario(`Portrait diagnostic reads saved fields without generation${denial ? ' after sign-in failure' : ''}`, {
    casePortfolio: true, portraitDiagnostic: true, width: 375,
    ...(denial ? { accessDenials: { 'GET /api/creatives/portfolios/portrait-diagnostic': 401 } } : {}) }, async ({ page, calls }) => {
    const failedCard = page.locator('article').filter({ hasText: 'Creative 2 could not be completed.' });
    await failedCard.getByText('The actual retained portrait PNG did not pass human or overlay checks. Saved creatives remain available.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Saved portfolio progress' }).getByRole('button', { name: 'Show portrait diagnostic for Creative 2', exact: true }).count(), 0);
    await failedCard.getByRole('button', { name: 'Show portrait diagnostic for Creative 2', exact: true }).click();
    if (denial) await page.getByText('Generation is paused. Sign in to restore the same saved portfolio.', { exact: false }).waitFor();
    else { await page.getByText('Model reason: Visible mark remains.', { exact: true }).waitFor();
      await page.getByRole('img', { name: 'Exact assessed portrait crop for Creative 2' }).waitFor();
      await page.getByText('Saved case frame: 21.333 seconds. Selected candidate: 66.', { exact: true }).waitFor();
      await page.getByText('Uncropped source PNG: 600 x 600 pixels. Crop coordinates are relative to this extracted PNG.', { exact: true }).waitFor();
      await page.getByText('Uncropped source PNG for comparison', { exact: true }).click();
      await page.getByRole('img', { name: 'Exact uncropped source frame for Creative 2' }).waitFor(); }
    assert.equal(await page.getByText('1 / 2', { exact: true }).count(), 1);
    assert.equal(calls.filter(([path, method]) => path === '/api/creatives/portfolios' && method !== 'GET').length, 0);
    assert.ok(calls.filter(([path]) => path.includes('portrait-diagnostic')).every(([, method]) => method === 'GET'));
  });
  for(const denied of [false,true]) await scenario(`Revised crop stages preserve case and never auto-generate${denied?' after authentication denial':''}`,{casePortfolio:true,revisedCrop:true,width:375},async({page,calls,submissions,response,denyAccess})=>{
    const progress=page.getByRole('region',{name:'Saved portfolio progress'});
    await page.getByRole('button',{name:'Show portrait diagnostic for Creative 2',exact:true}).click();
    const recovery=page.getByRole('region',{name:'Creative 2 crop recovery'});
    await recovery.getByLabel('Crop removal permille').fill('437');
    assert.equal(await recovery.getByRole('button',{name:'Prepare revised crop without AI'}).count(),0);
    await recovery.getByRole('button',{name:'Preview revised crop without AI'}).click();
    await recovery.getByRole('img',{name:'Unapproved revised portrait for Creative 2'}).waitFor();
    assert.equal(submissions.length,0);const prepare=recovery.getByRole('button',{name:'Prepare revised crop without AI'});assert.equal(await prepare.isDisabled(),true);
    await recovery.getByRole('checkbox').check();await prepare.click();
    const assess=progress.getByRole('button',{name:'Assess revised portrait for Creative 2'});await assess.waitFor();
    assert.deepEqual(submissions.map(x=>x.action),['recover-bound-case-crop']);assert.equal(await progress.getByRole('button',{name:'Resume generation',exact:true}).count(),0);
    assert.equal(await progress.getByRole('button',{name:'Generate Creative 2 from verified crop'}).count(),0);
    await page.reload();await progress.getByRole('button',{name:'Assess revised portrait for Creative 2'}).waitFor();
    assert.deepEqual(submissions.map(x=>x.action),['recover-bound-case-crop']);assert.deepEqual(response().draft.choices.claims,[claim]);
    if(denied)denyAccess('PATCH /api/creatives/portfolios',401);
    await progress.getByRole('button',{name:'Assess revised portrait for Creative 2'}).click();
    if(denied){await progress.getByText('Generation is paused. Sign in to restore the same saved portfolio.',{exact:false}).waitFor();assert.equal(await assess.isDisabled(),true);assert.equal(submissions.length,1);}
    else{
      const generate=progress.getByRole('button',{name:'Generate Creative 2 from verified crop'});await generate.waitFor();
      assert.deepEqual(submissions.map(x=>x.action),['recover-bound-case-crop','assess-bound-case-crop']);assert.equal(await progress.getByRole('button',{name:'Resume generation',exact:true}).count(),0);
      await page.reload();await generate.waitFor();assert.equal(submissions.length,2);
      await generate.click();await progress.getByText('Generation complete.',{exact:true}).waitFor();
      assert.deepEqual(submissions.map(x=>x.action),['recover-bound-case-crop','assess-bound-case-crop','generate-bound-case-crop']);
    }
    assert.equal(submissions.some(x=>['advance','retry'].includes(x.action)),false);
    assert.ok(calls.filter(([path])=>path.includes('portrait-diagnostic')).every(([,method])=>method==='GET'));
  });
  for (const guard of ['missing-pin', 'active-step']) await scenario(`Portrait diagnostic failed-card guard ${guard}`, {
    casePortfolio: true, portraitDiagnostic: true, width: 375, noPortraitPin: guard === 'missing-pin', portraitLease: guard === 'active-step' }, async ({ page, calls }) => {
    const card = page.locator('article').filter({ hasText: 'Creative 2 could not be completed.' }); await card.waitFor();
    const action = card.getByRole('button', { name: 'Show portrait diagnostic for Creative 2', exact: true });
    if (guard === 'missing-pin') assert.equal(await action.count(), 0);
    else assert.equal(await action.isDisabled(), true);
    assert.equal(calls.some(([path]) => path.includes('portrait-diagnostic')), false);
    assert.equal(calls.filter(([path, method]) => path === '/api/creatives/portfolios' && method !== 'GET').length, 0);
  });
  for (const width of [375, 390, 430, 1280]) await scenario(`Mobile layout recovery keeps long video names and saved statements within ${width}px`,
    { width, inventory: [mediaId, availableB], videoName: 'media_989a125a5f274761a27ff9115f1bae19.mp4', frameCount: 15, selectedFrameCount: 11,
      statementCount: 4, longStatements: true, savedPortfolio: true, pausedRecovery: true }, async ({ page, calls, response }) => {
      await ready(page); const panel = page.getByRole('region', { name: 'Video material review' });
      await panel.getByText('11 selected', { exact: true }).waitFor();
      const select = panel.getByLabel('Video', { exact: true }); await select.waitFor();
      // Native controls can use larger platform/user text metrics than Windows WebKit's default.
      await page.addStyleTag({ content: 'select { font-size: 20px !important; }' });
      const bounds = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
        offenders: [...document.querySelectorAll('main *')].filter(element => element.getBoundingClientRect().right > innerWidth + 1 && !element.closest('[class*="frames"]')).slice(0, 8).map(element => ({ tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right })) }));
      assert.ok(bounds.width <= width + 1, JSON.stringify(bounds)); assert.equal(bounds.viewport, width);
      const box = await select.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width);
      await select.selectOption(availableB); await select.selectOption(mediaId); await ready(page);
      const before = structuredClone(response()); await page.reload(); await ready(page);
      assert.deepEqual(response(), before); assert.equal(response().draft.choices.frames.length, 11);
      const viewport = await page.locator('meta[name=viewport]').getAttribute('content');
      assert.ok(!/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(?:[,\s]|$)/i.test(viewport));
      assert.equal(calls.some(([path, method]) => path === '/api/creatives/portfolios' && method !== 'GET'), false);
    });
  for (const key of ['GET /api/video/review-sources', 'POST /api/video/review-sources', 'GET /api/video/review-selection', 'GET /api/video/intelligence/jobs']) await scenario(`Cross-panel authentication recovery blocks paid controls for ${key}`,
    { savedPortfolio: true, pausedRecovery: true, accessDenials: { [key]: 401 } }, async ({ page, calls, denyAccess }) => {
      const resume = page.getByRole('button', { name: 'Resume generation', exact: true }); await resume.waitFor();
      await page.getByRole('link', { name: 'Sign in to restore saved progress', exact: true }).waitFor();
      assert.equal(await resume.isDisabled(), true);
      await page.getByRole('button', { name: 'Reload saved progress', exact: true }).click();
      await page.waitForFunction(() => !document.body.textContent.includes('Loading saved progress.'));
      assert.equal(await resume.isDisabled(), true, 'A portfolio GET cannot clear another resource\'s 401');
      denyAccess(key, 0);
      if (key === 'GET /api/video/review-selection') await page.getByRole('button', { name: 'Reload saved review', exact: true }).click();
      else if (key === 'GET /api/video/intelligence/jobs') await page.getByRole('button', { name: 'Reload saved videos', exact: true }).click();
      else if (key.startsWith('POST')) await page.getByRole('button', { name: 'Reload statement sources', exact: true }).click();
      else await page.getByRole('button', { name: 'Reload video material', exact: true }).click();
      await page.getByText('Generation is paused. Resume to continue the saved plan.', { exact: true }).waitFor();
      assert.equal(await resume.isEnabled(), true);
      assert.equal(calls.some(([path, method]) => path === '/api/creatives/portfolios' && method !== 'GET'), false);
    });
  await scenario('HTML video authentication recovery preserves saved work and blocks paid controls',
    { savedPortfolio: true, pausedRecovery: true, htmlDenial: true, accessDenials: { 'GET /api/video/review-sources': 401 } }, async ({ page, calls, denyAccess }) => {
      await page.getByRole('link', { name: 'Sign in to restore saved progress', exact: true }).waitFor();
      const resume = page.getByRole('button', { name: 'Resume generation', exact: true }); assert.equal(await resume.isDisabled(), true);
      await page.getByText('HTTP 401:', { exact: false }).waitFor();
      denyAccess('GET /api/video/review-sources', 0); await page.getByRole('button', { name: 'Reload video material', exact: true }).click();
      await page.getByText('Generation is paused. Resume to continue the saved plan.', { exact: true }).waitFor();
      assert.equal(await resume.isEnabled(), true);
      assert.equal(calls.some(([path, method]) => path === '/api/creatives/portfolios' && method !== 'GET'), false);
    });
  await scenario('Unselected nearby preview authentication recovery reloads the same video without a stranded paid gate',
    { savedPortfolio: true, pausedRecovery: true, frameCount: 3, representativeCount: 1 }, async ({ page, calls, denyAccess, response }) => {
      await ready(page); const panel = page.getByRole('region', { name: 'Video material review' });
      const saved = structuredClone(response()); await panel.getByRole('button', { name: 'View nearby frames', exact: true }).click();
      denyAccess('GET /api/video/review-sources', 401); await panel.getByRole('button', { name: 'Preview 00:02', exact: true }).click();
      await panel.getByText('HTTP 401:', { exact: false }).waitFor();
      const resume = page.getByRole('button', { name: 'Resume generation', exact: true }); assert.equal(await resume.isDisabled(), true);
      denyAccess('GET /api/video/review-sources', 0); await panel.getByRole('button', { name: 'Reload video material', exact: true }).click();
      await page.getByText('Generation is paused. Resume to continue the saved plan.', { exact: true }).waitFor();
      assert.equal(await resume.isEnabled(), true); assert.deepEqual(response(), saved);
      assert.equal(await page.getByRole('link', { name: 'Sign in to restore saved progress', exact: true }).count(), 0);
      assert.equal(calls.some(([path, method]) => path === '/api/creatives/portfolios' && method !== 'GET'), false);
    });
  await scenario('Saved portfolio recovery on navigation and focus is read-only', { savedPortfolio: true, pausedRecovery: true }, async ({ page, calls }) => {
    await page.getByText('Generation is paused. Resume to continue the saved plan.', { exact: true }).waitFor();
    const savedLink = new URL(await page.getByRole('link', { name: 'Open saved portfolio', exact: true }).getAttribute('href'), page.url());
    assert.equal(savedLink.searchParams.get('review'), id); assert.equal(savedLink.searchParams.get('portfolio'), job().id);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: 'Reload saved progress', exact: true }).click();
    await page.reload(); await page.getByText('Generation is paused. Resume to continue the saved plan.', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('review'), id);
    assert.equal(calls.some(([path, method]) => path === '/api/creatives/portfolios' && method !== 'GET'), false);
  });
  await scenario('Background return recovery pauses after current step and never advances automatically', { pausedRecovery: true, holdPortfolioAdvance: true }, async ({ page, calls, releasePortfolioAdvance }) => {
    await ready(page); await page.getByRole('slider', { name: 'Number of creatives to generate' }).fill('2');
    const advanceStarted = page.waitForRequest(request => new URL(request.url()).pathname === '/api/creatives/portfolios' && request.method() === 'PATCH');
    await generateButton(page).click();
    await advanceStarted.catch(async () => { throw new Error('Background fixture could not start an advance: ' + await page.locator('body').innerText()); });
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    releasePortfolioAdvance();
    await page.getByText('Generation stopped. Saved progress is preserved.', { exact: true }).waitFor();
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.getByText('Generation is paused. Resume to continue the saved plan.', { exact: true }).waitFor();
    assert.equal(calls.filter(([path, method]) => path === '/api/creatives/portfolios' && method === 'PATCH').length, 1);
    assert.equal(calls.filter(([path, method]) => path === '/api/creatives/portfolios' && method === 'POST').length, 1);
  });
  for (const returnWhilePending of [false, true]) await scenario(`Sidebar navigation recovery pauses continuation and reloads on return ${returnWhilePending ? 'during' : 'after'} the current step`,
    { pausedRecovery: true, holdPortfolioAdvance: true }, async ({ page, calls, releasePortfolioAdvance }) => {
      await ready(page); await page.getByRole('slider', { name: 'Number of creatives to generate' }).fill('2');
      const started = page.waitForRequest(request => new URL(request.url()).pathname === '/api/creatives/portfolios' && request.method() === 'PATCH');
      await generateButton(page).click(); await started;
      await page.locator('nav button').filter({ hasText: 'Company' }).click();
      const create = page.locator('nav button').filter({ hasText: 'Create' });
      if (returnWhilePending) await create.click();
      const settled = page.waitForResponse(response => new URL(response.url()).pathname === '/api/creatives/portfolios' && response.request().method() === 'PATCH');
      releasePortfolioAdvance(); await settled;
      if (!returnWhilePending) await create.click();
      await page.getByText('Generation is paused. Resume to continue the saved plan.', { exact: true }).waitFor();
      assert.equal(calls.filter(([path, method]) => path === '/api/creatives/portfolios' && method === 'PATCH').length, 1);
      assert.equal(calls.filter(([path, method]) => path === '/api/creatives/portfolios' && method === 'POST').length, 1);
      assert.ok(calls.some(([path, method]) => path === '/api/creatives/portfolios' && method === 'GET'));
      assert.equal(new URL(page.url()).searchParams.get('portfolio'), job().id);
      assert.equal(new URL(page.url()).searchParams.get('review'), id);
    });
  await scenario('Expired session recovery preserves portfolio and review query without paid work', { savedPortfolio: true, pausedRecovery: true }, async ({ page, calls, denyPortfolioLoads }) => {
    await page.getByText('Generation is paused. Resume to continue the saved plan.', { exact: true }).waitFor();
    await page.evaluate(({ portfolio, review }) => window.history.replaceState(null, '', `/?portfolio=${portfolio}&review=${review}`), { portfolio: job().id, review: id });
    denyPortfolioLoads(401); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const signIn = page.getByRole('link', { name: 'Sign in to restore saved progress', exact: true }); await signIn.waitFor();
    const href = new URL(await signIn.getAttribute('href'), page.url());
    assert.equal(href.pathname, '/sign-in'); assert.equal(href.searchParams.get('redirect_url'), `/?portfolio=${job().id}&review=${id}`);
    assert.equal(await page.getByRole('button', { name: 'Resume generation', exact: true }).isDisabled(), true);
    assert.equal(calls.some(([path, method]) => path === '/api/creatives/portfolios' && method !== 'GET'), false);
  });
  for (const initializationDenied of [false, true]) await scenario(`Visible approved reassessment initialization ${initializationDenied ? 'denied' : 'succeeds without paid advance'}`,
    { previewInitialization: true, initializationDenied, generationDelay: 300, noLogo: true, acceptancePreview: true }, async ({ page, calls, submissions }) => {
      const button = page.getByRole('button', { name: 'Prepare approved reassessment', exact: true });
      await button.waitFor(); assert.equal(submissions.length, 0);
      assert.equal(await page.getByRole('button', { name: 'Retry planning', exact: true }).count(), 0);
      await button.click(); assert.equal(await button.isDisabled(), true);
      if (initializationDenied) {
        await page.locator('.generation-error').filter({ hasText: 'Fixture initialization denied.' }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get('portfolio'), previewSourceId);
        assert.equal(await page.getByRole('button', { name: 'Resume generation', exact: true }).count(), 0);
      } else {
        await page.getByRole('button', { name: 'Resume generation', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Resume generation', exact: true }).isEnabled(), true);
        assert.equal(new URL(page.url()).searchParams.get('portfolio'), previewNewId);
        assert.equal(await button.count(), 0);
        await page.reload(); await page.getByRole('button', { name: 'Resume generation', exact: true }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get('portfolio'), previewNewId);
        await page.getByText('Logo omitted for this Preview test. Logo fidelity is not being evaluated.', { exact: true }).waitFor();
      }
      assert.equal(submissions.length, 1);
      assert.equal(calls.some(([path, method]) => path === '/api/creatives/portfolios' && method === 'PATCH'), false);
    });
  await scenario('Explicit no-logo Preview test stops at cached checkpoint and persists its scope on reload',
    { noLogo: true, acceptancePreview: true, cachedPreflight: true, linkedLayout: layoutMediaId }, async ({ page, calls, submissions }) => {
      await ready(page);
      await page.getByText('Generate may run paid source preparation, planning, and image generation using your connected API account. Operation quotas do not guarantee a dollar ceiling.', { exact: true }).waitFor();
      assert.equal(await page.getByText('Preview acceptance: Generate checks cached inputs and pauses before paid planning.', { exact: true }).count(), 0);
      await page.getByRole('slider', { name: 'Number of creatives to generate' }).fill('2');
      await page.getByRole('combobox', { name: 'Creative format' }).selectOption('PORTRAIT_4_5');
      await page.getByLabel('Run this Preview test without a logo').check();
      await generateButton(page).click();
      await page.getByText('Cached-input preflight passed.', { exact: false }).waitFor();
      await page.getByText('Logo omitted for this Preview test. Logo fidelity is not being evaluated.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Resume generation', exact: true }).waitFor();
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0].previewOmitBrandLogo, true); assert.equal(submissions[0].brandLogoMediaId, undefined);
      assert.equal(submissions[0].variationCount, 2); assert.equal(submissions[0].placement, 'PORTRAIT_4_5');
      assert.equal(calls.some(([path, method]) => path === '/api/creatives/portfolios' && method === 'PATCH'), false);
      await page.reload();
      await page.getByText('Logo omitted for this Preview test. Logo fidelity is not being evaluated.', { exact: true }).waitFor();
      assert.equal(calls.some(([path, method]) => path === '/api/creatives/portfolios' && method === 'PATCH'), false);
    });
  for (const source of ['video', 'layout']) await scenario(`Saved source UI handoff keeps ${source} removal across refresh while a sibling read is pending`,
    { noSavedReview: true, inventory: [], linkedVideo: availableB, linkedLayout: layoutMediaId, runWhilePending: true,
      holdSourceReadPaths: [source === 'video' ? '/api/references' : '/api/video/intelligence/jobs'] }, async ({ page, calls, videoActions, releaseSourceReads }) => {
      const removedName = source === 'video' ? 'second.mp4' : 'fixture-layout.png';
      const retainedName = source === 'video' ? 'fixture-layout.png' : 'second.mp4';
      const key = source === 'video' ? 'tax-marketing-studio-create-video-ids-v1' : 'tax-marketing-studio-create-linked-layout-ids-v1';
      await page.getByLabel(`Remove ${removedName}`).click();
      assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key), []);
      await page.reload(); releaseSourceReads(); await page.getByLabel(`Remove ${retainedName}`).waitFor();
      await page.waitForFunction(() => !document.body.textContent.includes('Restoring saved videos'));
      assert.equal(await page.getByLabel(`Remove ${removedName}`).count(), 0);
      assert.equal(videoActions.length, 0);
      assert.equal(calls.some(([path]) => path.startsWith('/api/media/upload') || path === '/api/media/confirm' || path === '/api/creatives/portfolios'), false);
    });
  await scenario('Saved source UI handoff survives refresh while its first reads are pending',
    { noSavedReview: true, inventory: [], linkedVideo: availableB, linkedLayout: layoutMediaId,
      holdSourceReads: true, runWhilePending: true }, async ({ page, calls, videoActions, releaseSourceReads }) => {
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('tax-marketing-studio-create-video-ids-v1') ?? '[]').length === 1
        && JSON.parse(localStorage.getItem('tax-marketing-studio-create-linked-layout-ids-v1') ?? '[]').length === 1);
      assert.equal(await page.getByLabel('Remove second.mp4').count(), 0);
      assert.equal(await page.getByLabel('Remove fixture-layout.png').count(), 0);
      assert.equal(new URL(page.url()).searchParams.has('videoMediaId'), false);
      assert.equal(new URL(page.url()).searchParams.has('layoutMediaId'), false);
      await page.reload();
      releaseSourceReads();
      await page.getByLabel('Remove second.mp4').waitFor(); await page.getByLabel('Remove fixture-layout.png').waitFor();
      assert.equal(await page.getByRole('combobox', { name: 'Source role for fixture-layout.png' }).inputValue(), 'LAYOUT_REFERENCE');
      assert.equal(videoActions.length, 0);
      assert.equal(calls.some(([path]) => path.startsWith('/api/media/upload') || path === '/api/media/confirm' || path === '/api/creatives/portfolios'), false);
    });
  await scenario('Saved layout UI handoff preserves its role and removal without upload or paid work',
    { noSavedReview: true, inventory: [], linkedVideo: availableB, linkedLayout: layoutMediaId }, async ({ page, calls, videoActions }) => {
      await page.getByLabel('Remove fixture-layout.png').waitFor();
      assert.equal(await page.getByRole('combobox', { name: 'Source role for fixture-layout.png' }).inputValue(), 'LAYOUT_REFERENCE');
      assert.equal(new URL(page.url()).searchParams.has('layoutMediaId'), false);
      await page.reload(); await page.getByLabel('Remove fixture-layout.png').waitFor();
      assert.equal(videoActions.length, 0);
      assert.equal(calls.some(([path]) => path.startsWith('/api/media/upload') || path === '/api/media/confirm' || path === '/api/creatives/portfolios'), false);
      await page.getByLabel('Remove fixture-layout.png').click(); await page.reload();
      await page.waitForFunction(() => !document.body.textContent.includes('Restoring saved videos'));
      assert.equal(await page.getByLabel('Remove fixture-layout.png').count(), 0);
    });
  await scenario('Saved layout UI handoff refuses a TRA asset with the same ID',
    { noSavedReview: true, inventory: [], linkedVideo: availableB, linkedLayout: layoutMediaId, wrongLayoutType: true }, async ({ page, calls }) => {
      await page.getByText('Saved layout reference is unavailable.', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Remove fixture-layout.png').count(), 0);
      assert.equal(calls.some(([path]) => path.startsWith('/api/media/upload') || path === '/api/creatives/portfolios'), false);
    });
  await scenario('Saved video UI handoff restores a fresh context without upload or paid work',
    { noSavedReview: true, inventory: [], linkedVideo: availableB }, async ({ page, calls, videoActions }) => {
      await page.getByLabel('Remove second.mp4').waitFor();
      await page.getByText('Video material ready', { exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.has('videoMediaId'), false);
      await page.reload(); await page.getByLabel('Remove second.mp4').waitFor();
      assert.equal(videoActions.length, 0);
      assert.equal(calls.some(([path]) => path.startsWith('/api/media/upload') || path === '/api/media/confirm'), false);
      assert.equal(calls.some(([path]) => path === '/api/creatives/portfolios'), false);
      await page.getByLabel('Remove second.mp4').click(); await page.reload();
      await page.waitForFunction(() => !document.body.textContent.includes('Restoring saved videos'));
      assert.equal(await page.getByLabel('Remove second.mp4').count(), 0);
    });
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
    await panel.getByRole('button', { name: 'Reload video material' }).click();
    await panel.getByText('Sign in again', { exact: false }).waitFor({ state: 'hidden' });
    await page.getByText('Video material ready').waitFor();
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
        await page.screenshot({ path: join(tmpdir(), `tra-307-mobile-${width}-${index}.png`), fullPage: true });
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
      await page.evaluate(() => localStorage.setItem('tax-marketing-studio-creative-portfolio-v1', `portfolio_${'4'.repeat(32)}`)); await page.reload();
      await page.getByRole('region', { name: 'Saved portfolio progress' }).waitFor();
      await page.getByRole('button', { name: portfolioState === 'PENDING' ? 'Resume generation' : 'Retry creative 1', exact: true }).click();
      await page.getByText('Generation complete.').waitFor(); assert.deepEqual(response(), before); assert.equal(saves.length, 0);
    });
  await scenario('A supplied company video can be submitted without requiring an unrelated logo', { noLogo: true }, async ({ page, submissions }) => {
    await ready(page); await generateButton(page).click();
    await page.getByText('Generation needs attention.').waitFor();
    assert.equal(submissions.length, 1); assert.equal(submissions[0].brandLogoMediaId, undefined);
    assert.equal(submissions[0].previewOmitBrandLogo, undefined);
    assert.deepEqual(submissions[0].sourceAssets, [{ mediaId, role: 'TRA_VIDEO' }]);
  });
  await scenario('Review → Create exact revision/manual frames; refresh and reopen are read-only', {}, async ({ page, calls, submissions }) => {
    await ready(page); assert.equal(await page.getByRole('region', { name: 'Video material review' }).locator('[data-frame-id] input[type=checkbox]').first().isChecked(), true);
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
    await page.evaluate(() => localStorage.setItem('tax-marketing-studio-create-video-ids-v1', JSON.stringify([`media_${'b'.repeat(32)}`, `media_${'9'.repeat(32)}`])));
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
    await ready(page); assert.equal(await page.getByRole('region', { name: 'Video material review' }).locator('[data-frame-id] input[type=checkbox]').first().isChecked(), false);
    await generateButton(page).click(); await page.getByText('Generation needs attention.').waitFor();
    assert.deepEqual(response().draft.choices.frames, frames); assert.equal(submissions.length, 1);
  });
  await scenario('Manual selection save uses settled revision; Profile navigation preserves choices', { frames: null }, async ({ page, submissions, response }) => {
    await ready(page); await page.getByRole('region', { name: 'Video material review' }).locator('[data-frame-id] input[type=checkbox]').first().check(); await page.getByText('Saved ✓').waitFor();
    await page.getByRole('navigation', { name: 'Creative workspace' }).getByRole('button').filter({ hasText: 'Company' }).click(); await page.getByRole('navigation', { name: 'Creative workspace' }).getByRole('button').filter({ hasText: 'Create' }).click();
    assert.equal(await page.getByRole('region', { name: 'Video material review' }).locator('[data-frame-id] input[type=checkbox]').first().isChecked(), true);
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
    await page.evaluate(() => localStorage.setItem('tax-marketing-studio-creative-portfolio-v1', `portfolio_${'4'.repeat(32)}`)); await page.reload();
    await page.getByRole('region', { name: 'Saved portfolio progress' }).waitFor();
    assert.equal(calls.filter(([path, method]) => path === '/api/creatives/portfolios' && method !== 'GET').length, 0);
    if (portfolioState === 'PENDING') { await page.getByRole('button', { name: 'Resume generation' }).click(); await page.getByText('Generation complete.').waitFor(); }
    else if (portfolioState === 'RETRY_REQUIRED') { await page.getByRole('button', { name: 'Retry creative 1', exact: true }).click(); await page.getByText('Generation complete.').waitFor(); }
    else await page.getByText('Generation complete.').waitFor();
  });
  await scenario('Clean-frame recovery prepares Creative 2 without generation and survives reload', { casePortfolio: true, caseRecovery: true, width: 375 }, async ({ page, calls }) => {
    const prepare = page.getByRole('button', { name: 'Prepare clean-frame recovery for Creative 2', exact: true });
    await prepare.click();
    await page.getByRole('button', { name: 'Resume generation', exact: true }).waitFor();
    assert.equal(await prepare.count(), 0);
    await page.getByRole('button', { name: 'Reload saved progress', exact: true }).click();
    await page.getByText('Generation is paused. Resume to continue the saved plan.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Resume generation', exact: true }).isEnabled(), true);
    assert.equal(await page.getByText('1 / 2', { exact: true }).count(), 1);
    assert.equal(calls.filter(([path, method]) => path === '/api/creatives/portfolios' && method !== 'GET').length, 1);
  });
  await scenario('Clean-frame recovery respects sign-in failure without generation or saved-slot changes', { casePortfolio: true, caseRecovery: true, width: 375,
    accessDenials: { 'PATCH /api/creatives/portfolios': 401 } }, async ({ page, calls }) => {
    const prepare = page.getByRole('button', { name: 'Prepare clean-frame recovery for Creative 2', exact: true });
    await prepare.click();
    await page.getByText('Generation is paused. Sign in to restore the same saved portfolio.', { exact: false }).waitFor();
    assert.equal(await prepare.isDisabled(), true);
    assert.equal(await page.getByText('1 / 2', { exact: true }).count(), 1);
    assert.equal(calls.filter(([path, method]) => path === '/api/creatives/portfolios' && method !== 'GET').length, 1);
  });
  await scenario('Saved case amendment reload releases the Resume editor hold', { casePortfolio: true, width: 375 }, async ({ page, calls }) => {
    const resume = page.getByRole('button', { name: 'Resume generation', exact: true });
    await page.getByRole('button', { name: 'Use selected video cases', exact: true }).click();
    const statements = page.getByRole('combobox', { name: /case statement$/ }), frames = page.getByRole('combobox', { name: /person frame$/ });
    await statements.nth(0).selectOption('0'); await frames.nth(0).selectOption(frame.frameId);
    await statements.nth(1).selectOption('1'); await frames.nth(1).selectOption(`video-frame:${'9'.repeat(64)}`);
    const editor = page.getByRole('region', { name: 'Video case amendment' });
    await editor.getByRole('checkbox').nth(0).check(); await editor.getByRole('checkbox').nth(1).check();
    await page.getByRole('button', { name: 'Preview amendment without generating' }).click();
    await page.getByRole('button', { name: 'Save amendment without generating' }).click();
    await page.getByRole('button', { name: 'Reload saved progress', exact: true }).click();
    await page.getByText('Generation is paused. Resume to continue the saved plan.', { exact: true }).waitFor();
    console.log('Saved/reloaded state: ' + JSON.stringify({ resumeDisabled: await resume.isDisabled(), editorCloseVisible: await page.getByRole('button', { name: 'Close case amendment' }).count() }));
    assert.equal(await resume.isDisabled(), false, 'Saving and read-only reload must release the editor hold without resuming');
    assert.equal(calls.some(([path, method]) => path === '/api/creatives/portfolios' && method !== 'GET'), false, 'No paid advance');
    assert.equal(calls.filter(([path, method]) => path === '/api/creatives/portfolios/case-amendment' && method === 'PATCH').length, 1);
  });
  for (const { width, plannedCases } of [{ width: 375 }, { width: 1280 }, { width: 375, plannedCases: true }]) await scenario(`Video case amendment preserves distinct people and explicit save at ${width}px${plannedCases ? ' with ordinary planned cases' : ''}`, { caseAmendment: true, width, plannedCases }, async ({ page, calls }) => {
    const statements = page.getByRole('combobox', { name: /case statement$/ }), frames = page.getByRole('combobox', { name: /person frame$/ });
    if (plannedCases) {
      await page.getByRole('heading', { name: 'Confirm planned video cases' }).waitFor();
      assert.equal(await statements.nth(0).inputValue(), '0'); assert.equal(await statements.nth(1).inputValue(), '1');
      assert.equal(await frames.nth(0).inputValue(), frame.frameId); assert.equal(await frames.nth(1).inputValue(), `video-frame:${'9'.repeat(64)}`);
      assert.equal(await page.getByRole('checkbox').nth(0).isChecked(), false); assert.equal(await page.getByRole('checkbox').nth(1).isChecked(), false);
    }
    await statements.nth(0).selectOption('0'); await frames.nth(0).selectOption(frame.frameId);
    await statements.nth(1).selectOption('1'); await frames.nth(1).selectOption(`video-frame:${'9'.repeat(64)}`);
    await page.getByRole('button', { name: 'Preview amendment without generating' }).click();
    const save = page.getByRole('button', { name: 'Save amendment without generating' }); await save.waitFor();
    assert.equal(await save.isDisabled(), true);
    const confirmations = page.getByRole('checkbox'); await confirmations.nth(0).check(); await confirmations.nth(1).check();
    assert.equal(await save.count(), 0, 'Changing attribution invalidates the previous proposal');
    await page.getByRole('button', { name: 'Preview amendment without generating' }).click(); await save.waitFor();
    const beforeSave = calls.filter(([, method]) => method === 'PATCH').length; assert.equal(beforeSave, 0);
    await save.click(); await page.getByText('Case amendment saved.', { exact: false }).waitFor();
    await page.reload(); await page.getByText('Case amendment saved.', { exact: false }).waitFor();
    assert.equal(calls.filter(([, method]) => method === 'PATCH').length, 1);
    assert.equal(calls.some(([path]) => path !== '/api/creatives/portfolios/case-amendment'), false, 'No source analysis, generation or portfolio advance');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  });
  console.log(`${results.length} offline ${browserName === 'webkit' ? 'WebKit' : 'Chromium'} scenarios passed.`);
} finally { await browser.close(); await server.close(); }
