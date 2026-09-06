import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { withTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-lifecycle';
import { analyzeTemporaryVideoCandidates } from '@/lib/video/candidate-technical-selection';
import { assembleVideoFrameLibrary, type VideoFrameLibrary } from '@/lib/video/frame-library';
import { createVideoFrameThumbnail, type VideoFrameThumbnail } from '@/lib/video/frame-thumbnail';
import { MAX_TRANSCRIPTION_UPLOAD_BYTES, transcribeTraVideo } from '@/lib/video/transcript';
import { observeTemporaryVideoFrame, parseFrameVisualObservation } from '@/lib/video/visual-observation';

export const assertLocalVideoIntelligence = () => {
  if (process.env.NODE_ENV === 'production') throw new Error('Video intelligence is currently available in local development only.');
};
export const videoSourceHash = (source: HydratedTraVideoSource) => createHash('sha256').update(source.stored.buffer).digest('hex');
const libraryPath = (mediaId: string, hash: string, root: string) => {
  assertLocalVideoIntelligence();
  if (!/^media_[a-f0-9]{32}$/.test(mediaId) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid video library source identity.');
  return path.join(root, mediaId, `${hash}.json`);
};
const defaultRoot = () => path.join(process.cwd(), '.runtime', 'video-intelligence');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isInteger = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value);
const isHash = (value: unknown, length = 64) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isPersistedVideoFrameLibrary = (value: unknown, mediaId: string, hash: string): value is VideoFrameLibrary => {
  if (!isRecord(value) || value.version !== 1 || value.sourceVideoMediaId !== mediaId || value.sourceVideoContentHash !== hash
    || value.providerEligible !== false || value.evidenceStatus !== 'UNVERIFIED_MODEL_OBSERVATION'
    || !isFiniteNumber(value.durationMs) || value.durationMs <= 0 || value.id !== `video-library:${createHash('sha256').update(`${mediaId}:${hash}`).digest('hex')}`
    || !isRecord(value.analysisModels) || value.analysisModels.transcription !== 'whisper-1' || !isStringArray(value.analysisModels.vision) || !value.analysisModels.vision.length
    || !isRecord(value.transcript) || value.transcript.version !== 1 || value.transcript.model !== 'whisper-1' || typeof value.transcript.language !== 'string' || !Array.isArray(value.transcript.segments)
    || !Array.isArray(value.candidates) || !value.candidates.length || !Array.isArray(value.representativeFrames) || !value.representativeFrames.length
    || !isRecord(value.semanticGroups) || !Array.isArray(value.semanticGroups.sceneTypes) || !Array.isArray(value.semanticGroups.topics)) return false;
  const candidates = new Map<number, Record<string, unknown>>();
  for (const candidate of value.candidates) {
    if (!isRecord(candidate) || !isInteger(candidate.candidateIndex) || candidate.candidateIndex < 0 || candidates.has(candidate.candidateIndex)
      || !isFiniteNumber(candidate.timestampMs) || candidate.timestampMs < 0 || candidate.timestampMs > value.durationMs
      || !isInteger(candidate.width) || candidate.width <= 0 || !isInteger(candidate.height) || candidate.height <= 0
      || !isHash(candidate.frameSha256) || !Array.isArray(candidate.extractionReasons) || !candidate.extractionReasons.length
      || !candidate.extractionReasons.every((reason) => reason === 'INTERVAL' || reason === 'SCENE_CHANGE')
      || !isRecord(candidate.technical) || !isFiniteNumber(candidate.technical.qualityScore)) return false;
    candidates.set(candidate.candidateIndex, candidate);
  }
  const representativeIndexes = new Set<number>();
  const representedCandidates = new Set<number>();
  for (const frame of value.representativeFrames) {
    if (!isRecord(frame) || !isInteger(frame.candidateIndex) || representativeIndexes.has(frame.candidateIndex)
      || !Array.isArray(frame.candidateIndexes) || !frame.candidateIndexes.length || !frame.candidateIndexes.every((index) => isInteger(index) && candidates.has(index))
      || !frame.candidateIndexes.includes(frame.candidateIndex) || !isFiniteNumber(frame.timestampMs) || !isHash(frame.frameSha256)
      || typeof frame.thumbnailDataUrl !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.thumbnailDataUrl)
      || !isRecord(frame.observation) || !Array.isArray(frame.transcriptSegments)) return false;
    const candidate = candidates.get(frame.candidateIndex)!;
    if (frame.timestampMs !== candidate.timestampMs || frame.frameSha256 !== candidate.frameSha256
      || frame.id !== `video-frame:${createHash('sha256').update(`${hash}:${candidate.timestampMs}:${candidate.frameSha256}`).digest('hex')}`) return false;
    try { parseFrameVisualObservation(frame.observation); } catch { return false; }
    for (const index of frame.candidateIndexes) {
      if (representedCandidates.has(index)) return false;
      representedCandidates.add(index);
    }
    representativeIndexes.add(frame.candidateIndex);
  }
  if (representedCandidates.size !== candidates.size) return false;
  for (const segment of value.transcript.segments) {
    if (!isRecord(segment) || !isInteger(segment.segmentIndex) || !isFiniteNumber(segment.startMs) || !isFiniteNumber(segment.endMs)
      || segment.startMs < 0 || segment.endMs <= segment.startMs || segment.endMs > value.durationMs || typeof segment.text !== 'string') return false;
  }
  return true;
};

const activeAnalyses = new Map<string, Promise<{ library: VideoFrameLibrary; reused: boolean }>>();

export const loadVideoFrameLibrary = async (mediaId: string, hash: string, root = defaultRoot()): Promise<VideoFrameLibrary | null> => {
  const file = libraryPath(mediaId, hash, root);
  let bytes: string;
  try { bytes = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const value = JSON.parse(bytes);
    return isPersistedVideoFrameLibrary(value, mediaId, hash) ? value : null;
  } catch { return null; }
};

export const analyzeTraVideoIntelligence = async (
  source: HydratedTraVideoSource,
  options: { root?: string; force?: boolean; request?: typeof fetch; onProgress?: (message: string) => void } = {}
): Promise<{ library: VideoFrameLibrary; reused: boolean }> => {
  assertLocalVideoIntelligence();
  if (source.role !== 'TRA_VIDEO' || source.media.mediaType !== 'VIDEO' || source.stored.mimeType !== 'video/mp4') {
    throw new Error('Video intelligence requires a server-hydrated TRA_VIDEO MP4.');
  }
  if (source.stored.buffer.length > MAX_TRANSCRIPTION_UPLOAD_BYTES) throw new Error('Video intelligence currently accepts MP4 files up to 25 MB.');
  const hash = videoSourceHash(source);
  const root = options.root || defaultRoot();
  const file = libraryPath(source.media.id, hash, root);
  const model = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra';
  const key = JSON.stringify([path.resolve(root), source.media.id, hash, model]);
  const active = activeAnalyses.get(key);
  if (active) return active;
  const pending = (async () => {
    const cached = options.force ? null : await loadVideoFrameLibrary(source.media.id, hash, root);
    if (cached?.analysisModels.vision.length === 1 && cached.analysisModels.vision[0] === model) return { library: cached, reused: true };
    options.onProgress?.('Extracting and checking candidate frames');
    const library = await withTemporaryTraVideoFrameCandidates(source, async (set) => {
    const technical = await analyzeTemporaryVideoCandidates(set);
    options.onProgress?.(`Transcribing speech; ${technical.groups.length} visual representatives`);
    const transcript = await transcribeTraVideo(source, set.durationMs, { request: options.request });
    const observations: Awaited<ReturnType<typeof observeTemporaryVideoFrame>>[] = [];
    const thumbnails = new Map<number, VideoFrameThumbnail>();
    for (let start = 0; start < technical.groups.length; start += 2) {
      // Drain each pair before cleanup even when one provider call fails.
      const results = await Promise.allSettled(technical.groups.slice(start, start + 2).map(async (group) => {
        const frame = set.candidates[group.representativeIndex];
        const observation = await observeTemporaryVideoFrame(frame, { request: options.request });
        const thumbnail = await createVideoFrameThumbnail(frame);
        return { observation, thumbnail };
      }));
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        observations.push(result.value.observation);
        thumbnails.set(result.value.observation.candidateIndex, result.value.thumbnail);
      }
      options.onProgress?.(`Analyzed ${observations.length} of ${technical.groups.length} representatives`);
    }
    return assembleVideoFrameLibrary(set, technical, transcript, observations, thumbnails);
    });
    await mkdir(path.dirname(file), { recursive: true });
    const temporaryFile = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryFile, JSON.stringify(library), { flag: 'wx' });
      await rename(temporaryFile, file);
    } finally { await rm(temporaryFile, { force: true }); }
    return { library, reused: false };
  })();
  activeAnalyses.set(key, pending);
  try { return await pending; } finally { activeAnalyses.delete(key); }
};
