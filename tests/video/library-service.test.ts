import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { analyzeTraVideoIntelligence, loadVideoFrameLibrary, videoSourceHash } from '@/lib/video/library-service';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { REAL_MULTI_FRAME_MP4 } from '@/tests/fixtures/media';

const source: HydratedTraVideoSource = { role: 'TRA_VIDEO',
  media: { id: `media_${'a'.repeat(32)}`, fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', size: REAL_MULTI_FRAME_MP4.length, url: '' },
  stored: { fileName: 'source.mp4', buffer: REAL_MULTI_FRAME_MP4, mimeType: 'video/mp4', mediaType: 'VIDEO' } };
let root = '';
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
const request = () => vi.fn<typeof fetch>(async (url) => String(url).endsWith('/transcriptions')
  ? Response.json({ language: 'en', segments: [{ start: 0, end: 1, text: 'Sample speech.' }] })
  : Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
    sceneType: 'OTHER', summary: 'Colored test frame.', composition: 'Full frame.', visibleText: [], topics: ['other'], uncertainties: [],
  }) }] }] }));

it('runs real extraction with mocked providers, persists complete analysis, and reuses it without paid calls', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tra-library-service-test-'));
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'test-model');
  const provider = request();
  const progress = vi.fn();
  const first = await analyzeTraVideoIntelligence(source, { root, request: provider, onProgress: progress });
  expect(first.reused).toBe(false);
  expect(first.library.representativeFrames.length).toBeGreaterThan(0);
  expect(first.library.representativeFrames[0].thumbnailDataUrl).toMatch(/^data:image\/jpeg;base64,/);
  expect(first.library.providerEligible).toBe(false);
  expect(progress).toHaveBeenCalled();
  expect(await loadVideoFrameLibrary(source.media.id, videoSourceHash(source), root)).toEqual(first.library);
  provider.mockClear();
  const second = await analyzeTraVideoIntelligence(source, { root, request: provider });
  expect(second.reused).toBe(true);
  expect(second.library).toEqual(first.library);
  expect(provider).not.toHaveBeenCalled();
  expect(await loadVideoFrameLibrary(source.media.id, 'b'.repeat(64), root)).toBeNull();
  await writeFile(path.join(root, source.media.id, `${videoSourceHash(source)}.json`), '{broken');
  expect(await loadVideoFrameLibrary(source.media.id, videoSourceHash(source), root)).toBeNull();
}, 30_000);

it('does not persist failed provider runs and rejects production or oversized inputs before paid calls', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tra-library-service-test-'));
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  const provider = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }));
  await expect(analyzeTraVideoIntelligence(source, { root, request: provider })).rejects.toThrow('HTTP 429');
  expect(await loadVideoFrameLibrary(source.media.id, videoSourceHash(source), root)).toBeNull();
  provider.mockClear();
  const oversized = { ...source, stored: { ...source.stored, buffer: Buffer.alloc(25_000_001) } };
  await expect(analyzeTraVideoIntelligence(oversized, { root, request: provider })).rejects.toThrow('25 MB');
  vi.stubEnv('NODE_ENV', 'production');
  await expect(analyzeTraVideoIntelligence(source, { root, request: provider })).rejects.toThrow('local development only');
  await expect(loadVideoFrameLibrary(source.media.id, videoSourceHash(source), root)).rejects.toThrow('local development only');
  expect(provider).not.toHaveBeenCalled();
}, 30_000);
