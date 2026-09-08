import { createHash } from 'node:crypto';
import { validateStoredMedia } from '@/lib/media/storage';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';

export interface VideoTranscriptSegment {
  segmentIndex: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface VideoTranscript {
  version: 1;
  model: 'whisper-1';
  sourceVideoMediaId: string;
  sourceVideoContentHash: string;
  language: string;
  segments: VideoTranscriptSegment[];
}

export const MAX_TRANSCRIPTION_UPLOAD_BYTES = 25_000_000;
export const VIDEO_TRANSCRIPTION_TIMEOUT_MS = 120_000;

export const parseTranscriptSegments = (payload: unknown, durationMs: number) => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('A validated video duration is required.');
  const raw = payload as { language?: unknown; segments?: unknown } | null;
  if (!raw || typeof raw.language !== 'string' || !Array.isArray(raw.segments)) {
    throw new Error('Transcription provider returned an invalid timestamped transcript.');
  }
  const segments: VideoTranscriptSegment[] = [];
  let previousStart = -1;
  for (const value of raw.segments) {
    const segment = value as { start?: unknown; end?: unknown; text?: unknown } | null;
    if (!segment || typeof segment.start !== 'number' || !Number.isFinite(segment.start)
      || typeof segment.end !== 'number' || !Number.isFinite(segment.end)
      || segment.start < 0 || segment.end <= segment.start || segment.start < previousStart
      || typeof segment.text !== 'string') {
      throw new Error('Transcription provider returned invalid segment timing or text.');
    }
    previousStart = segment.start;
    const startMs = Math.round(segment.start * 1000);
    const endMs = Math.min(durationMs, Math.round(segment.end * 1000));
    // Audio may outlast the selected video stream. Keep only its overlap.
    if (endMs > startMs && segment.text.trim()) {
      segments.push({ segmentIndex: segments.length, startMs, endMs, text: segment.text.trim() });
    }
  }
  return { language: raw.language, segments };
};

export const transcribeTraVideo = async (
  source: HydratedTraVideoSource,
  durationMs: number,
  dependencies: { request?: typeof fetch } = {}
): Promise<VideoTranscript> => {
  if (source.role !== 'TRA_VIDEO' || source.media.mediaType !== 'VIDEO'
    || source.stored.mediaType !== 'VIDEO' || source.stored.mimeType !== 'video/mp4') {
    throw new Error('Only a hydrated TRA_VIDEO MP4 can be transcribed.');
  }
  validateStoredMedia(source.stored);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('A validated video duration is required.');
  if (source.stored.buffer.length > MAX_TRANSCRIPTION_UPLOAD_BYTES) {
    throw new Error('Video transcription currently accepts MP4 files up to 25 MB.');
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured for video transcription.');
  const sourceVideoContentHash = createHash('sha256').update(source.stored.buffer).digest('hex');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(source.stored.buffer)], { type: 'video/mp4' }), source.stored.fileName);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  const response = await (dependencies.request || fetch)('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    signal: AbortSignal.timeout(VIDEO_TRANSCRIPTION_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Video transcription failed (HTTP ${response.status}). Check audio, API access, and limits.`);
  return {
    version: 1, model: 'whisper-1', sourceVideoMediaId: source.media.id, sourceVideoContentHash,
    ...parseTranscriptSegments(await response.json(), durationMs),
  };
};

// Half-open intervals preserve gaps and avoid attaching adjacent speech at a cut.
// Temporal overlap is context, not proof of the visible person's identity.
export const transcriptAtTimestamp = (transcript: VideoTranscript, timestampMs: number) =>
  transcript.segments.filter((segment) => segment.startMs <= timestampMs && timestampMs < segment.endMs);
