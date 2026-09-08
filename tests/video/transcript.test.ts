import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTranscriptSegments, transcribeTraVideo, transcriptAtTimestamp } from '@/lib/video/transcript';
import { probeTraVideoAudioTrack } from '@/lib/video/ffmpeg';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { REAL_MULTI_FRAME_MP4 } from '@/tests/fixtures/media';

const source: HydratedTraVideoSource = {
  role: 'TRA_VIDEO',
  media: { id: `media_${'a'.repeat(32)}`, fileName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', size: REAL_MULTI_FRAME_MP4.length, url: '' },
  stored: { fileName: 'source.mp4', buffer: REAL_MULTI_FRAME_MP4, mimeType: 'video/mp4', mediaType: 'VIDEO' },
};
const payload = { language: 'english', segments: [
  { start: 0.1, end: 1, text: 'First segment.' }, { start: 2, end: 5, text: 'Later speech.' },
] };
const audioProbe = async () => ({ hasAudioTrack: true });
afterEach(() => vi.unstubAllEnvs());

describe('timestamped video transcription', () => {
  it('sends original MP4 to the audio endpoint and binds validated segments to source bytes', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    const result = await transcribeTraVideo(source, 4_000, { request, probe: audioProbe });
    expect(result.sourceVideoContentHash).toBe(createHash('sha256').update(REAL_MULTI_FRAME_MP4).digest('hex'));
    expect(result.sourceVideoMediaId).toBe(source.media.id);
    const [url, options] = request.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    const body = options!.body as FormData;
    expect(body.get('model')).toBe('whisper-1');
    expect(body.get('response_format')).toBe('verbose_json');
    expect(body.get('timestamp_granularities[]')).toBe('segment');
    expect(Buffer.from(await (body.get('file') as Blob).arrayBuffer())).toEqual(REAL_MULTI_FRAME_MP4);
    expect(options!.signal).toBeInstanceOf(AbortSignal);
    expect(result.segments[1].endMs).toBe(4_000);
    expect(transcriptAtTimestamp(result, 999)).toHaveLength(1);
    expect(transcriptAtTimestamp(result, 1_000)).toEqual([]);
    expect(transcriptAtTimestamp(result, 1_500)).toEqual([]);
    expect(transcriptAtTimestamp(result, 2_000)[0].text).toBe('Later speech.');
  });

  it.each([
    null, { language: 'en' }, { language: 'en', segments: [{ start: -1, end: 1, text: 'bad' }] },
    { language: 'en', segments: [{ start: 2, end: 1, text: 'bad' }] },
    { language: 'en', segments: [{ start: 1, end: 2, text: 'ok' }, { start: 0, end: 1, text: 'bad' }] },
    { language: 'en', segments: [{ start: 0, end: Infinity, text: 'bad' }] },
  ])('rejects malformed provider timing %j', (value) => {
    expect(() => parseTranscriptSegments(value, 4_000)).toThrow();
  });

  it('preserves no-speech results and excludes audio beyond the video timeline', () => {
    expect(parseTranscriptSegments({ language: 'en', segments: [] }, 4_000).segments).toEqual([]);
    expect(parseTranscriptSegments({ language: 'en', segments: [{ start: 5, end: 6, text: 'audio only' }] }, 4_000).segments).toEqual([]);
  });

  it('fails before upload for missing credentials and oversized MP4s, and surfaces provider failures', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }));
    vi.stubEnv('OPENAI_API_KEY', '');
    await expect(transcribeTraVideo(source, 4_000, { request, probe: audioProbe })).rejects.toThrow('OPENAI_API_KEY');
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const oversized = { ...source, stored: { ...source.stored, buffer: Buffer.concat([REAL_MULTI_FRAME_MP4, Buffer.alloc(25_000_001)]) } };
    await expect(transcribeTraVideo(oversized, 4_000, { request, probe: audioProbe })).rejects.toThrow('25 MB');
    expect(request).not.toHaveBeenCalled();
    await expect(transcribeTraVideo(source, 4_000, { request, probe: audioProbe })).rejects.toThrow('HTTP 429');
  });

  it('skips confirmed no-audio video before credentials or provider upload', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(transcribeTraVideo(source, 4_000, { request, probe: async () => ({ hasAudioTrack: false }) }))
      .resolves.toMatchObject({ status: 'SKIPPED_NO_AUDIO_TRACK', model: null, language: null, segments: [],
        sourceVideoMediaId: source.media.id, sourceVideoContentHash: createHash('sha256').update(REAL_MULTI_FRAME_MP4).digest('hex'),
        evidence: { method: 'FFMPEG_STREAM_METADATA' } });
    expect(request).not.toHaveBeenCalled();
  });

  it('recognizes the real reordered fixture as decodable video without an audio stream', async () => {
    await expect(probeTraVideoAudioTrack(REAL_MULTI_FRAME_MP4)).resolves.toEqual({ hasAudioTrack: false });
  });

  it('does not treat failed or ambiguous probes as no-audio', async () => {
    await expect(transcribeTraVideo(source, 4_000, { probe: async () => { throw new Error('decode failed'); } })).rejects.toThrow('decode failed');
    await expect(transcribeTraVideo(source, 4_000, { probe: async () => ({}) as { hasAudioTrack: boolean } })).rejects.toThrow('ambiguous');
  });
});
