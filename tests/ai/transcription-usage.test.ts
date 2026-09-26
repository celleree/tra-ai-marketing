import { afterEach, expect, it, vi } from 'vitest';
import { fetchWithProviderUsage } from '@/lib/ai/provider-telemetry';

afterEach(() => vi.restoreAllMocks());
it('preserves multipart audio bytes, names, options and abort signal while recording only billing seconds', async () => {
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const form = new FormData(); form.append('file', new Blob(['PRIVATE_AUDIO']), 'PRIVATE_PERSON.mp4');
  form.append('model', 'whisper-1'); form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'segment');
  const request = { method: 'POST', body: form, headers: { Authorization: 'Bearer PRIVATE_KEY' }, signal: new AbortController().signal };
  const response = Response.json({ text: 'PRIVATE_TRANSCRIPT', duration: 8.47, usage: { type: 'duration', seconds: 9 } });
  const dispatch = vi.fn<typeof fetch>(async () => response);
  expect(await fetchWithProviderUsage('video-transcription', 'https://api.openai.com/v1/audio/transcriptions', request, dispatch)).toBe(response);
  expect(dispatch.mock.calls[0][1]).toBe(request); expect(dispatch.mock.calls[0][1]!.body).toBe(form);
  const event = JSON.parse(String(logs.mock.calls[1][0]));
  expect(event).toMatchObject({ endpoint: 'transcription', model: 'whisper-1', usage: { audioSeconds: 9 },
    estimatedCostUsd: .0009, confirmedBilledCostUsd: null });
  expect(JSON.stringify(logs.mock.calls)).not.toContain('PRIVATE');
  expect(await response.json()).toHaveProperty('text', 'PRIVATE_TRANSCRIPT');
});
it('does not treat top-level duration as reported billing usage', async () => {
  const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
  const form = new FormData(); form.append('model', 'whisper-1');
  await fetchWithProviderUsage('video-transcription', 'https://api.openai.com/v1/audio/transcriptions', { method: 'POST', body: form },
    async () => Response.json({ duration: 8.47, text: 'PRIVATE' }));
  expect(JSON.parse(String(logs.mock.calls[1][0]))).toMatchObject({ usage: null, estimatedCostUsd: null });
});
