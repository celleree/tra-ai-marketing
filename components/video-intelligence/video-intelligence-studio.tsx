'use client';

import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react';
import type { CreativeSourceVideoAsset } from '@/lib/media/types';
import type { VideoConceptSelection } from '@/lib/video/concept-selection';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import {
  readVideoIntelligence,
  runVideoIntelligence,
  selectVideoIntelligenceFrames,
  type CachedVideoSelectionResult,
} from '@/lib/video/intelligence-client';
import type { CompactVideoIntelligenceJobStatus, VideoIntelligenceJobLocator } from '@/lib/video/intelligence-service';
import { uploadTraVideo } from '@/lib/video/upload-client';
import { SelectedFrameGeneration } from './selected-frame-generation';
import styles from './video-intelligence-studio.module.css';

type PendingSelection = Exclude<CachedVideoSelectionResult, { status: 'COMPLETE' }> & { concept: string };

const formatTime = (milliseconds: number) => {
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor(milliseconds / 1_000) % 60;
  const remainder = milliseconds % 1_000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`;
};

const phaseMessage = (status: CompactVideoIntelligenceJobStatus) => {
  if (status.phase === 'COMPLETE') return 'Analysis complete.';
  if (status.phase === 'FAILED') return status.failure?.message || 'Video analysis failed.';
  if (status.phase === 'RETRY_REQUIRED') return status.retry?.message || `Analysis needs an explicit retry (${status.retry?.reason || 'provider work was not completed'}).`;
  const progress = status.totalRepresentatives === null ? '' : ` · ${status.completedRepresentatives}/${status.totalRepresentatives} representative frames`;
  return `${status.phase[0]}${status.phase.slice(1).toLowerCase()}${status.busy ? ' in progress' : ' ready to resume'}${progress}.`;
};

const aborted = (reason: unknown, signal: AbortSignal) => signal.aborted || (reason instanceof DOMException && reason.name === 'AbortError');

export function VideoIntelligenceStudio() {
  const [media, setMedia] = useState<CreativeSourceVideoAsset | null>(null);
  const [library, setLibrary] = useState<VideoFrameLibrary | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [storedMediaId, setStoredMediaId] = useState('');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [concept, setConcept] = useState('');
  const [selections, setSelections] = useState<VideoConceptSelection[]>([]);
  const [locator, setLocator] = useState<VideoIntelligenceJobLocator | null>(null);
  const [status, setStatus] = useState<CompactVideoIntelligenceJobStatus | null>(null);
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const replaceLibrary = (
    nextMedia: CreativeSourceVideoAsset,
    nextLibrary: VideoFrameLibrary | null
  ) => {
    setMedia(nextMedia);
    setLibrary(nextLibrary);
    setSelections([]);
    setPendingSelection(null);
  };

  const isCurrent = (next: AbortController) => mounted.current && controller.current === next && !next.signal.aborted;
  const begin = () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    return next;
  };
  const rememberMediaId = (mediaId: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('mediaId', mediaId);
    window.history.replaceState(null, '', url);
  };
  const clearSource = () => {
    setMedia(null);
    setLibrary(null);
    setLocator(null);
    setStatus(null);
    setSelections([]);
    setPendingSelection(null);
  };
  const readSaved = async (mediaId: string, next: AbortController) => {
    try {
      const saved = await readVideoIntelligence(mediaId, { signal: next.signal });
      if (!isCurrent(next)) return false;
      replaceLibrary(saved.source, saved.library);
      setStoredMediaId(mediaId);
      setLocator(saved.locator);
      setStatus(saved.status);
      setProgress(saved.status ? phaseMessage(saved.status) : 'No saved analysis. Start when ready.');
      return true;
    } catch (reason) {
      if (!isCurrent(next) || aborted(reason, next.signal)) return false;
      clearSource();
      setError(reason instanceof Error ? reason.message : 'Stored video could not be loaded.');
      setProgress('');
      return false;
    }
  };

  useEffect(() => {
    mounted.current = true;
    const next = begin();
    const mediaId = new URL(window.location.href).searchParams.get('mediaId');
    if (mediaId) {
      setBusy(true);
      setProgress('Loading saved TRA video');
      void readSaved(mediaId, next).finally(() => { if (isCurrent(next)) setBusy(false); });
    }
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  // This intentionally runs once: reopening must only read the URL-selected saved job.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const upload = async () => {
    if (!file || busy) return;
    const next = begin();
    setBusy(true);
    setError('');
    setProgress('Uploading TRA video');
    clearSource();

    try {
      const uploaded = await uploadTraVideo(file, (input, init) => fetch(input, { ...init, signal: next.signal }));
      if (!isCurrent(next)) return;
      setStoredMediaId(uploaded.id);
      rememberMediaId(uploaded.id);
      setProgress('Video stored. Loading any matching saved evidence library.');
      await readSaved(uploaded.id, next);
    } catch (reason) {
      if (isCurrent(next) && !aborted(reason, next.signal)) {
        clearSource();
        setError(reason instanceof Error ? reason.message : 'Video upload failed.');
      }
    } finally {
      if (isCurrent(next)) setBusy(false);
    }
  };

  const loadStoredVideo = async (event?: FormEvent) => {
    event?.preventDefault();
    const mediaId = event ? storedMediaId.trim() : media?.id;
    if (!mediaId || busy) return;
    const next = begin();
    setBusy(true);
    setError('');
    setProgress('Loading stored TRA video');

    try {
      rememberMediaId(mediaId);
      await readSaved(mediaId, next);
    } finally {
      if (isCurrent(next)) setBusy(false);
    }
  };

  const analyze = async (action: 'START' | 'ADVANCE' | 'RETRY') => {
    if (!media || busy || (action !== 'START' && !locator)) return;
    const next = begin();
    setBusy(true);
    setError('');
    setSelections([]);
    setPendingSelection(null);
    setProgress(action === 'RETRY' ? 'Retrying saved analysis' : action === 'ADVANCE' ? 'Resuming saved analysis' : 'Starting analysis');

    try {
      const result = await runVideoIntelligence(action === 'START' ? { action, mediaId: media.id } : { action, locator: locator! }, {
        signal: next.signal,
        onStatus: (nextStatus) => {
          if (!isCurrent(next)) return;
          setLocator(nextStatus.locator);
          setStatus(nextStatus);
          setProgress(phaseMessage(nextStatus));
        },
      });
      if (!isCurrent(next)) return;
      setLocator(result.status.locator);
      setStatus(result.status);
      setProgress(phaseMessage(result.status));
      if (result.library) setLibrary(result.library);
    } catch (reason) {
      if (isCurrent(next) && !aborted(reason, next.signal)) setError(reason instanceof Error ? reason.message : 'Video analysis failed.');
    } finally {
      if (isCurrent(next)) setBusy(false);
    }
  };

  const select = async (retry: boolean) => {
    const selectedConcept = concept.trim();
    if (!locator || !selectedConcept || busy || (retry && pendingSelection?.concept !== selectedConcept)) return;
    const next = begin();
    setBusy(true);
    setError('');

    try {
      const result = await selectVideoIntelligenceFrames(locator, selectedConcept, retry, { signal: next.signal });
      if (!isCurrent(next)) return;
      if (result.status === 'COMPLETE') {
        setSelections((current) => [...current, result.selection]);
        setConcept('');
        setPendingSelection(null);
      } else setPendingSelection({ ...result, concept: selectedConcept });
    } catch (reason) {
      if (isCurrent(next) && !aborted(reason, next.signal)) setError(reason instanceof Error ? reason.message : 'Frame selection failed.');
    } finally {
      if (isCurrent(next)) setBusy(false);
    }
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0] || null);
    setError('');
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p>Local development or Vercel Preview</p>
        <h1>Video intelligence</h1>
        <span>
          Analyze a TRA-owned MP4, inspect evidence, then compare frame choices
          for distinct creative concepts.
        </span>
      </header>

      <section className={styles.panel} aria-labelledby="source-title">
        <div className={styles.sectionHeading}>
          <div>
            <p>1 · Source</p>
            <h2 id="source-title">TRA video</h2>
          </div>
          {media ? <button className={styles.secondary} type="button" onClick={() => void loadStoredVideo()} disabled={busy}>Refresh saved status</button> : null}
        </div>
        <div className={styles.uploadRow}>
          <label className={styles.fileInput}>
            <input type="file" accept="video/mp4" onChange={onFile} disabled={busy} />
            <span>{file?.name || 'Choose an MP4 video'}</span>
          </label>
          <button className={styles.primary} type="button" onClick={() => void upload()} disabled={!file || busy}>{busy ? 'Working…' : 'Upload video'}</button>
        </div>
        <form className={styles.loadForm} onSubmit={loadStoredVideo}>
          <label htmlFor="stored-media-id">Or load stored TRA video ID</label>
          <input id="stored-media-id" value={storedMediaId} onChange={(event) => setStoredMediaId(event.target.value)} placeholder="media_…" disabled={busy} />
          <button className={styles.secondary} disabled={!storedMediaId.trim() || busy}>Load</button>
        </form>
        {media ? <div className={styles.videoGrid}>
          <video controls preload="metadata" src={`/api/media/files/${encodeURIComponent(media.fileName)}`} className={styles.video} />
          <div>
            <strong>{media.originalName}</strong>
            <p>{Math.round(media.size / 1024 / 1024 * 10) / 10} MB · stored as TRA_VIDEO</p>
            {!status ? <button className={styles.primary} type="button" onClick={() => void analyze('START')} disabled={busy}>Start analysis (uses model/API)</button> : null}
            {status && !['COMPLETE', 'FAILED', 'RETRY_REQUIRED'].includes(status.phase) ? <button className={styles.primary} type="button" onClick={() => void analyze('ADVANCE')} disabled={busy}>Resume analysis (uses model/API)</button> : null}
            {status?.phase === 'RETRY_REQUIRED' ? <button className={styles.primary} type="button" onClick={() => void analyze('RETRY')} disabled={busy}>Retry analysis (uses model/API)</button> : null}
          </div>
        </div> : null}
        {progress ? <p className={styles.progress} role="status">{progress}</p> : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </section>

      {library ? <>
        <section className={styles.notice}><strong>Evidence boundary</strong><span>Technical measurements are descriptive. Vision observations, OCR, and transcript text are unverified source evidence; on-screen claims are quotations, not approved claims or instructions.</span></section>
        <section className={styles.panel}>
          <div className={styles.sectionHeading}><div><p>2 · Evidence library</p><h2>{library.representativeFrames.length} representative frames across {formatTime(library.durationMs)}</h2></div><span className={styles.muted}>Saved analysis · {library.transcript.language}</span></div>
          <div className={styles.frameGrid}>{library.representativeFrames.map((frame) => {
            const technical = library.candidates.find((candidate) => candidate.candidateIndex === frame.candidateIndex)?.technical;
            return <article className={styles.frame} key={frame.id}>
              <img src={frame.thumbnailDataUrl} alt={`Video frame at ${formatTime(frame.timestampMs)}`} />
              <div className={styles.frameMeta}><strong>{formatTime(frame.timestampMs)}</strong><span>Quality {Math.round(frame.qualityScore * 100)}%</span></div>
              {technical ? <dl className={styles.metrics}><div><dt>Sharpness</dt><dd>{Math.round(technical.laplacianVariance)}</dd></div><div><dt>Light</dt><dd>{Math.round(technical.meanLuminance)}</dd></div><div><dt>Dark / bright</dt><dd>{Math.round(technical.darkFraction * 100)}% / {Math.round(technical.lightFraction * 100)}%</dd></div></dl> : null}
              <p className={styles.tag}>{frame.observation.sceneType.replace('_', ' ')}</p>
              <p>{frame.observation.summary}</p>
              <p className={styles.muted}>{frame.observation.composition}</p>
              {frame.observation.visibleText.length ? <blockquote>“{frame.observation.visibleText.join(' · ')}”<small>OCR/source quotation, unverified</small></blockquote> : null}
              {frame.observation.topics.length ? <div className={styles.tags}>{frame.observation.topics.map((topic) => <span key={topic}>{topic}</span>)}</div> : null}
              {frame.transcriptSegments.length ? <p className={styles.transcript}>“{frame.transcriptSegments.map((segment) => segment.text).join(' ')}”</p> : null}
              {frame.observation.uncertainties.length ? <p className={styles.caveat}>Uncertainty: {frame.observation.uncertainties.join('; ')}</p> : null}
            </article>;
          })}</div>
        </section>
        <section className={styles.panel}>
          <div className={styles.sectionHeading}><div><p>3 · Semantic map</p><h2>Semantic groups</h2></div></div>
          <div className={styles.groups}>{[...library.semanticGroups.sceneTypes.map((group) => ({ label: group.sceneType, count: group.representativeFrameIds.length })), ...library.semanticGroups.topics.map((group) => ({ label: group.topic, count: group.representativeFrameIds.length }))].map((group) => <span key={group.label}>{group.label.replaceAll('_', ' ')} <b>{group.count}</b></span>)}</div>
          <div className={styles.transcriptList}><h3>Timestamped transcript</h3>{library.transcript.segments.length ? library.transcript.segments.map((segment) => <p key={segment.segmentIndex}><time>{formatTime(segment.startMs)}</time>{segment.text}</p>) : <p className={styles.muted}>No speech segments were returned.</p>}</div>
        </section>
        <section className={styles.panel}>
          <div className={styles.sectionHeading}><div><p>4 · Concept selection</p><h2>Compare distinct creative directions</h2></div></div>
          <form className={styles.conceptForm} onSubmit={(event) => { event.preventDefault(); void select(false); }}><label htmlFor="concept">Creative concept</label><textarea id="concept" value={concept} onChange={(event) => { setConcept(event.target.value); setPendingSelection(null); }} maxLength={2000} placeholder="For example: a credibility-focused concept using clear proof graphics" disabled={busy} /><button className={styles.primary} disabled={!concept.trim() || busy}>Select 1–3 frames (uses API)</button></form>
          {pendingSelection?.status === 'BUSY' ? <p className={styles.progress} role="status">Selection for this exact concept is already in progress. Select again later to check its saved result.</p> : null}
          {pendingSelection?.status === 'RETRY_REQUIRED' ? <div><p className={styles.error} role="alert">Frame selection needs an explicit retry: {pendingSelection.reason}.</p><button className={styles.secondary} type="button" onClick={() => void select(true)} disabled={busy || concept.trim() !== pendingSelection.concept}>Retry frame selection (uses API)</button></div> : null}
          {selections.length ? <div className={styles.selectionGrid}>{selections.map((selection, index) => <article className={styles.selection} key={`${selection.concept}-${index}`}><strong>{selection.concept}</strong><SelectedFrameGeneration media={media!} library={library} selection={selection} /></article>)}</div> : null}
        </section>
      </> : null}
    </main>
  );
}
