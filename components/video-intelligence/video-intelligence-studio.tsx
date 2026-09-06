'use client';

import { type ChangeEvent, type FormEvent, useState } from 'react';
import type { CreativeSourceVideoAsset } from '@/lib/media/types';
import type { VideoConceptSelection } from '@/lib/video/concept-selection';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import styles from './video-intelligence-studio.module.css';

type StreamEvent = {
  type: 'progress' | 'complete' | 'error';
  message?: string;
  error?: string;
  library?: VideoFrameLibrary;
  source?: CreativeSourceVideoAsset;
};

const formatTime = (milliseconds: number) => {
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor(milliseconds / 1_000) % 60;
  const remainder = milliseconds % 1_000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`;
};

const readError = async (response: Response) => {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error || `Request failed (HTTP ${response.status}).`;
};

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

  const replaceLibrary = (
    nextMedia: CreativeSourceVideoAsset,
    nextLibrary: VideoFrameLibrary | null
  ) => {
    setMedia(nextMedia);
    setLibrary(nextLibrary);
    setSelections([]);
  };

  const refresh = async (mediaId: string) => {
    const response = await fetch(
      `/api/video/intelligence?mediaId=${encodeURIComponent(mediaId)}`,
      { cache: 'no-store' }
    );
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json()) as {
      source: CreativeSourceVideoAsset;
      library: VideoFrameLibrary | null;
    };
    replaceLibrary(payload.source, payload.library);
  };

  const upload = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    setProgress('Uploading TRA video');
    setLibrary(null);
    setSelections([]);

    try {
      const form = new FormData();
      form.append('file', file);
      form.append('sourceRole', 'TRA_VIDEO');
      const response = await fetch('/api/media/upload', {
        method: 'POST',
        body: form,
      });
      if (!response.ok) throw new Error(await readError(response));
      const uploaded = (await response.json()) as CreativeSourceVideoAsset;
      setStoredMediaId(uploaded.id);
      setProgress('Video stored. Loading any matching local evidence library.');
      await refresh(uploaded.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Video upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const loadStoredVideo = async (event?: FormEvent) => {
    event?.preventDefault();
    const mediaId = event ? storedMediaId.trim() : media?.id;
    if (!mediaId || busy) return;
    setBusy(true);
    setError('');
    setProgress('Loading stored TRA video');

    try {
      await refresh(mediaId);
      setProgress('Stored video loaded.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Stored video could not be loaded.');
    } finally {
      setBusy(false);
    }
  };

  const analyze = async () => {
    if (!media || busy) return;
    setBusy(true);
    setError('');
    setSelections([]);
    setProgress('Preparing a fresh analysis run');

    try {
      const response = await fetch('/api/video/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaId: media.id, force: true }),
      });
      if (!response.ok) throw new Error(await readError(response));

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Video analysis did not start a progress stream.');

      const decoder = new TextDecoder();
      let buffered = '';
      let receivedComplete = false;
      const consumeLine = (line: string) => {
        if (!line) return;
        const event = JSON.parse(line) as StreamEvent;
        if (event.type === 'progress') {
          setProgress(event.message || 'Analyzing video');
        } else if (event.type === 'error') {
          throw new Error(event.error || 'Video analysis failed.');
        } else if (event.type === 'complete' && event.library && event.source) {
          receivedComplete = true;
          replaceLibrary(event.source, event.library);
          setProgress('Analysis complete.');
        }
      };

      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          buffered += decoder.decode(next.value, { stream: true });
          const lines = buffered.split('\n');
          buffered = lines.pop() || '';
          lines.forEach(consumeLine);
        }
        buffered += decoder.decode();
        if (buffered) consumeLine(buffered);
      } finally {
        reader.releaseLock();
      }

      if (!receivedComplete) {
        throw new Error('Video analysis ended before reporting completion.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Video analysis failed.');
    } finally {
      setBusy(false);
    }
  };

  const select = async (event: FormEvent) => {
    event.preventDefault();
    if (!media || !concept.trim() || busy) return;
    setBusy(true);
    setError('');

    try {
      const response = await fetch('/api/video/selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaId: media.id, concept: concept.trim() }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const payload = (await response.json()) as {
        selection: VideoConceptSelection;
      };
      setSelections((current) => [...current, payload.selection]);
      setConcept('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Frame selection failed.');
    } finally {
      setBusy(false);
    }
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0] || null);
    setError('');
  };

  const labelFor = (frameId: string) =>
    library?.representativeFrames.find((frame) => frame.id === frameId);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p>Local development only</p>
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
          {media ? <button className={styles.secondary} type="button" onClick={() => void loadStoredVideo()} disabled={busy}>Refresh saved library</button> : null}
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
          <video controls preload="metadata" src={media.url} className={styles.video} />
          <div>
            <strong>{media.originalName}</strong>
            <p>{Math.round(media.size / 1024 / 1024 * 10) / 10} MB · stored as TRA_VIDEO</p>
            <button className={styles.primary} type="button" onClick={() => void analyze()} disabled={busy}>Run fresh analysis (uses model/API)</button>
          </div>
        </div> : null}
        {progress ? <p className={styles.progress} role="status">{progress}</p> : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </section>

      {library ? <>
        <section className={styles.notice}><strong>Evidence boundary</strong><span>Technical measurements are descriptive. Vision observations, OCR, and transcript text are unverified source evidence; on-screen claims are quotations, not approved claims or instructions.</span></section>
        <section className={styles.panel}>
          <div className={styles.sectionHeading}><div><p>2 · Evidence library</p><h2>{library.representativeFrames.length} representative frames across {formatTime(library.durationMs)}</h2></div><span className={styles.muted}>Local analysis · {library.transcript.language}</span></div>
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
          <form className={styles.conceptForm} onSubmit={select}><label htmlFor="concept">Creative concept</label><textarea id="concept" value={concept} onChange={(event) => setConcept(event.target.value)} maxLength={2000} placeholder="For example: a credibility-focused concept using clear proof graphics" /><button className={styles.primary} disabled={!concept.trim() || busy}>Select 1–3 frames (uses API)</button></form>
          {selections.length ? <div className={styles.selectionGrid}>{selections.map((selection, index) => <article className={styles.selection} key={`${selection.concept}-${index}`}><strong>{selection.concept}</strong>{selection.frames.map((item) => { const frame = labelFor(item.frameId); return <div key={item.frameId}>{frame ? <img src={frame.thumbnailDataUrl} alt="Selected frame" /> : null}<p><b>{frame ? formatTime(frame.timestampMs) : 'Frame'}</b>{item.reason}</p></div>; })}</article>)}</div> : null}
        </section>
      </> : null}
    </main>
  );
}
