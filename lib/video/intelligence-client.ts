import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import type { CompactVideoIntelligenceJobStatus, ExecuteVideoIntelligenceStepInput,
  readVideoIntelligenceSource, VideoIntelligenceJobLocator } from '@/lib/video/intelligence-service';
import type { selectVideoFramesWithCache } from '@/lib/video/selection-cache';

type SourceState = Awaited<ReturnType<typeof readVideoIntelligenceSource>>;
export type CachedVideoSelectionResult = Awaited<ReturnType<typeof selectVideoFramesWithCache>>;
export interface VideoIntelligenceClientOptions { signal: AbortSignal; request?: typeof fetch }
const endpoint = '/api/video/intelligence';

const json = async <T>(url: string, body: unknown | undefined, options: VideoIntelligenceClientOptions): Promise<T> => {
  options.signal.throwIfAborted();
  const response = await (options.request ?? fetch)(url, {
    signal: options.signal, cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(error.error || `Video request failed (HTTP ${response.status}).`);
  }
  return response.json() as Promise<T>;
};

const loadLibrary = (locator: VideoIntelligenceJobLocator, options: VideoIntelligenceClientOptions) =>
  json<VideoFrameLibrary>(`${endpoint}/library`, { locator }, options);

/** Reopening reads saved work only. It never starts or advances provider work. */
export const readVideoIntelligence = async (mediaId: string, options: VideoIntelligenceClientOptions) => {
  const state = await json<SourceState>(`${endpoint}/jobs?mediaId=${encodeURIComponent(mediaId)}`, undefined, options);
  const library = state.status?.phase === 'COMPLETE' ? await loadLibrary(state.locator, options) : null;
  return { ...state, library };
};

const pause = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 2_000);
  signal.addEventListener('abort', abort, { once: true });
});

/** Call only after an operator starts, resumes, or explicitly retries analysis. */
export const runVideoIntelligence = async (
  input: ExecuteVideoIntelligenceStepInput & { action: 'START' | 'ADVANCE' | 'RETRY' },
  options: VideoIntelligenceClientOptions & { onStatus: (status: CompactVideoIntelligenceJobStatus) => void }
) => {
  let next: ExecuteVideoIntelligenceStepInput = input;
  while (true) {
    const status = await json<CompactVideoIntelligenceJobStatus>(`${endpoint}/jobs`, next, options);
    options.signal.throwIfAborted();
    options.onStatus(status);
    if (status.phase === 'COMPLETE') return { status, library: await loadLibrary(status.locator, options) };
    if (status.phase === 'FAILED' || status.phase === 'RETRY_REQUIRED') return { status, library: null };
    if (status.busy) await pause(options.signal);
    // An expired paid lease is classified by ADVANCE; only a new explicit call may RETRY.
    next = { action: status.busy ? 'STATUS' : 'ADVANCE', locator: status.locator };
  }
};

/** A single cache-aware request. BUSY/retry states never trigger automatic paid retries. */
export const selectVideoIntelligenceFrames = (
  locator: VideoIntelligenceJobLocator, concept: string, retry: boolean, options: VideoIntelligenceClientOptions
) => json<CachedVideoSelectionResult>(`${endpoint}/selection`, { locator, concept: concept.trim(), retry }, options);
