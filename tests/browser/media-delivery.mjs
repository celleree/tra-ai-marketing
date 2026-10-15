import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const browserTypes = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const browserName = process.env.VIDEO_REVIEW_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
const vite = await createServer({ root, configFile: false, cacheDir: root + 'node_modules/.vite-media-delivery',
  resolve: { alias: { '@': root } }, server: { middlewareMode: true }, appType: 'custom' });
const { buildContentSecurityPolicy } = await vite.ssrLoadModule('/next.config.ts');
// PCM in <video> avoids optional H.264 codecs while exercising the same media CSP.
const pcm = Buffer.alloc(44 + 16000);
pcm.write('RIFF', 0); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(8000, 24); pcm.writeUInt32LE(16000, 28); pcm.writeUInt16LE(2, 32);
pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(16000, 40);
let deliveries = 0;
const server = createHttpServer((request, response) => {
  const port = server.address().port;
  const storageOrigin = `http://localhost:${port}`;
  if (request.url === '/api/media/files/source.mp4') {
    response.writeHead(307, { Location: `${storageOrigin}/source.wav`, 'Cache-Control': 'private, no-store' });
    return response.end();
  }
  if (request.url === '/source.wav') {
    deliveries++;
    response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': pcm.length });
    return response.end(pcm);
  }
  const environment = request.url === '/preview' ? 'preview' : 'production';
  // Substitute only the real policy's R2 media source with a second loopback
  // origin. Missing R2 permission still fails playback; no external service runs.
  const policy = buildContentSecurityPolicy({ nodeEnv: 'production', vercelEnv: environment })
    .split('; ').map(value => value.startsWith('media-src ')
      ? value.replace('https://*.r2.cloudflarestorage.com', storageOrigin) : value).join('; ');
  response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': policy });
  response.end('<!doctype html><script>window.violations=[];addEventListener("securitypolicyviolation",event=>window.violations.push(event.effectiveDirective));</script><video preload="auto" src="/api/media/files/source.mp4"></video>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await browserTypes[browserName].launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH && browserName === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}) });
try {
  for (const environment of ['production', 'preview']) {
    const context = await browser.newContext();
    try {
      await context.route('**/*', route => {
        const host = new URL(route.request().url()).hostname;
        return ['127.0.0.1', 'localhost'].includes(host) ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/${environment}`);
      await page.waitForFunction(() => document.querySelector('video').readyState >= 2 || document.querySelector('video').error);
      const loaded = await page.evaluate(() => ({ ready: document.querySelector('video').readyState, violations: window.violations }));
      assert.ok(loaded.ready >= 2, JSON.stringify(loaded));
      assert.equal(loaded.violations.includes('media-src'), false);
      assert.ok(deliveries > 0);
      await page.evaluate(() => {
        window.violations = [];
        const video = document.querySelector('video'); video.src = 'http://127.0.0.2/source.wav'; video.load();
      });
      await page.waitForFunction(() => window.violations.includes('media-src'));
      console.log(`PASS ${environment} private media redirect loads; unrelated media origin remains blocked`);
    } finally { await context.close(); }
  }
  console.log(`2 offline ${browserName} media-policy scenarios passed.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await vite.close(); }
