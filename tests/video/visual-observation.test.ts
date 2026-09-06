import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { TemporaryVideoFrameCandidate } from '@/lib/video/candidate-types';
import { observeTemporaryVideoFrame, parseFrameVisualObservation } from '@/lib/video/visual-observation';
import sharp from 'sharp';

const REAL_JPEG = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#888888' } }).jpeg().toBuffer();

const observation = { sceneType: 'PERSON', summary: 'A person beside text.', composition: 'Portrait close-up.',
  visibleText: ['Joseph'], topics: ['tax relief'], uncertainties: ['Name text does not establish who is visible.'] };
let directory = '';
afterEach(async () => { vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }); });
const candidate = async (): Promise<TemporaryVideoFrameCandidate> => {
  directory = await mkdtemp(path.join(tmpdir(), 'tra-observation-test-'));
  const temporaryPath = path.join(directory, 'frame.jpg');
  await writeFile(temporaryPath, REAL_JPEG);
  return { candidateIndex: 4, timestampMs: 1333, sourceRole: 'TRA_VIDEO', sourceVideoMediaId: `media_${'a'.repeat(32)}`,
    sourceVideoFileName: 'source.mp4', sourceVideoContentHash: 'b'.repeat(64), mimeType: 'image/jpeg', width: 1, height: 1,
    byteLength: REAL_JPEG.length, frameSha256: createHash('sha256').update(REAL_JPEG).digest('hex'),
    extractionReasons: ['INTERVAL'], temporaryPath, lifecycle: 'TEMPORARY', providerEligible: false };
};
const response = (value = observation) => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });

it('sends only candidate pixels to analysis, binds output on the server, and preserves ineligibility', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  const frame = await candidate();
  const request = vi.fn<typeof fetch>().mockResolvedValue(response());
  const result = await observeTemporaryVideoFrame(frame, { request });
  expect(result).toMatchObject({ sourceVideoContentHash: frame.sourceVideoContentHash, frameSha256: frame.frameSha256,
    candidateIndex: 4, timestampMs: 1333, providerEligible: false, observation });
  expect(result).not.toHaveProperty('approvedHumanSource');
  const [url, options] = request.mock.calls[0];
  expect(url).toBe('https://api.openai.com/v1/responses');
  const body = JSON.parse(options!.body as string);
  expect(body.store).toBe(false);
  expect(body.text.format.strict).toBe(true);
  expect(body.input[1].content[0].image_url).toBe(`data:image/jpeg;base64,${REAL_JPEG.toString('base64')}`);
  expect(body.input[0].content[0].text).toContain('Never recognize, name, or link a person by appearance');
  expect(options!.signal).toBeInstanceOf(AbortSignal);
});

it('rejects changed pixels before sending and fails clearly for missing credentials/provider errors', async () => {
  const frame = await candidate();
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }));
  vi.stubEnv('OPENAI_API_KEY', '');
  await expect(observeTemporaryVideoFrame(frame, { request })).rejects.toThrow('OPENAI_API_KEY');
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  await expect(observeTemporaryVideoFrame({ ...frame, frameSha256: '0'.repeat(64) }, { request })).rejects.toThrow('integrity');
  expect(request).not.toHaveBeenCalled();
  await expect(observeTemporaryVideoFrame(frame, { request })).rejects.toThrow('HTTP 429');
});

it.each([null, {}, { ...observation, sceneType: 'JOSEPH' }, { ...observation, topics: [42] }])('rejects malformed observations', (value) => {
  expect(() => parseFrameVisualObservation(value)).toThrow('invalid frame observation');
});

it('rejects refusals and incomplete responses instead of inventing metadata', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  const frame = await candidate();
  for (const payload of [{ status: 'completed', output: [{ content: [{ type: 'refusal' }] }] },
    { status: 'incomplete', output: [{ content: [{ type: 'output_text', text: JSON.stringify(observation) }] }] }]) {
    await expect(observeTemporaryVideoFrame(frame, { request: vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)) })).rejects.toThrow('no completed observation');
  }
});
