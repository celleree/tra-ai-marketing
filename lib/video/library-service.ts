import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { withTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-lifecycle';
import { analyzeTemporaryVideoCandidates } from '@/lib/video/candidate-technical-selection';
import { assembleVideoFrameLibrary, type VideoFrameLibrary } from '@/lib/video/frame-library';
import { MAX_TRANSCRIPTION_UPLOAD_BYTES, transcribeTraVideo } from '@/lib/video/transcript';
import { observeTemporaryVideoFrame } from '@/lib/video/visual-observation';

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

export const loadVideoFrameLibrary = async (mediaId: string, hash: string, root = defaultRoot()): Promise<VideoFrameLibrary | null> => {
  const file = libraryPath(mediaId, hash, root);
  let bytes: string;
  try { bytes = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const value = JSON.parse(bytes) as VideoFrameLibrary;
    if (value.version !== 1 || value.sourceVideoMediaId !== mediaId || value.sourceVideoContentHash !== hash
      || value.providerEligible !== false || value.evidenceStatus !== 'UNVERIFIED_MODEL_OBSERVATION'
      || !Number.isFinite(value.durationMs) || value.durationMs <= 0
      || !Array.isArray(value.candidates) || !Array.isArray(value.representativeFrames) || !value.representativeFrames.length
      || !Array.isArray(value.analysisModels?.vision)) return null;
    return value;
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
  const cached = options.force ? null : await loadVideoFrameLibrary(source.media.id, hash, root);
  const model = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra';
  if (cached?.analysisModels.vision.length === 1 && cached.analysisModels.vision[0] === model) return { library: cached, reused: true };
  options.onProgress?.('Extracting and checking candidate frames');
  const library = await withTemporaryTraVideoFrameCandidates(source, async (set) => {
    const technical = await analyzeTemporaryVideoCandidates(set);
    options.onProgress?.(`Transcribing speech; ${technical.groups.length} visual representatives`);
    const transcript = await transcribeTraVideo(source, set.durationMs, { request: options.request });
    const observations: Awaited<ReturnType<typeof observeTemporaryVideoFrame>>[] = [];
    const thumbnails = new Map<number, string>();
    for (let start = 0; start < technical.groups.length; start += 2) {
      // Drain each pair before cleanup even when one provider call fails.
      const results = await Promise.allSettled(technical.groups.slice(start, start + 2).map(async (group) => {
        const frame = set.candidates[group.representativeIndex];
        const observation = await observeTemporaryVideoFrame(frame, { request: options.request });
        const thumbnail = await sharp(await readFile(frame.temporaryPath)).resize({ width: 280, withoutEnlargement: true }).jpeg().toBuffer();
        return { observation, thumbnail: `data:image/jpeg;base64,${thumbnail.toString('base64')}` };
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
  const pending = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(pending, JSON.stringify(library), { flag: 'wx' });
    await rename(pending, file);
  } finally { await rm(pending, { force: true }); }
  return { library, reused: false };
};
