'use client';

import { useEffect, useRef, useState } from 'react';
import type { discoverVideoReviewSource } from '@/lib/video/review-source-discovery';
import type { VideoCandidateFrameBinding } from '@/lib/video/generation-selection-contract';
import type { useVideoReviewDraft } from './use-video-review-draft';
import styles from './video-review-panel.module.css';
import { runVideoIntelligence } from '@/lib/video/intelligence-client';
import { VideoReviewStatements } from './video-review-statements';
import { MAX_REVIEW_PREVIEW_BATCH } from '@/lib/video/review-preview-policy';
import { reviewRequestFailure } from '@/lib/video/review-selection-client';

export type ReviewSource = Awaited<ReturnType<typeof discoverVideoReviewSource>>;
const preparationLabel = { PREPARING: 'Preparing source', TRANSCRIBING: 'Transcribing', OBSERVING: 'Analyzing scenes',
  FINALIZING: 'Saving library', COMPLETE: 'Ready', FAILED: 'Preparation failed', RETRY_REQUIRED: 'Retry required' };
export const reviewTime = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000) % 60 < 10 ? '0' : ''}${Math.floor(ms / 1000) % 60}`;
export const toggleReviewFrame = (frames: VideoCandidateFrameBinding[] | null, frame: VideoCandidateFrameBinding) => {
  const current = frames ?? [];
  return current.some(item => item.frameId === frame.frameId) ? current.filter(item => item.frameId !== frame.frameId)
    : [...current, frame];
};

/** Saved selections belong to Create, independently of the video currently being browsed. */
export function SavedVideoReviewSummary({ draft }: { draft: ReturnType<typeof useVideoReviewDraft> }) {
  const saved = draft.state.saved, choices = saved?.draft.choices;
  if (!saved || !choices?.video) return null;
  return <section className={`panel ${styles.card}`} aria-label="Saved video review"
    data-review-id={saved.draft.id} data-review-revision={saved.revision} data-video-id={choices.video.locator.sourceVideoMediaId}>
    <strong>Saved selected material</strong>
    <p>{choices.frames?.length ? `${choices.frames.length} manually selected frames` : 'Automatic frame selection'}</p>
    {choices.frames?.map(frame => <p key={frame.frameId} data-frame-id={frame.frameId}>Selected frame at {reviewTime(frame.timestampMs)}</p>)}
    {saved.draft.claimSnapshots.map((statement, index) => <p key={index}>{statement.wording}</p>)}
  </section>;
}

export function VideoReviewPanel({ videos, draft, disabled = false }: { videos: Array<{ id: string; name: string }>;
  draft: ReturnType<typeof useVideoReviewDraft>; disabled?: boolean }) {
  const [active, setActive] = useState(''), [source, setSource] = useState<ReviewSource | null>(null);
  const [error, setError] = useState(''), [collapsed, setCollapsed] = useState(false);
  const [nearby, setNearby] = useState(false), [previews, setPreviews] = useState<Record<string, NonNullable<NonNullable<ReviewSource['review']>['preview']>>>({});
  const [previewBusy, setPreviewBusy] = useState(false);
  const [candidate, setCandidate] = useState<number | null>(null);
  const [working, setWorking] = useState(false), [refresh, setRefresh] = useState(0);

  const [previewRetry, setPreviewRetry] = useState(0), [failedImages, setFailedImages] = useState<Record<string, boolean>>({});

  const previewWork = useRef<Promise<void>>(Promise.resolve());
  const work = useRef<AbortController | null>(null);
  const savedId = draft.state.choices?.video?.locator.sourceVideoMediaId;
  const mediaId = videos.some(video => video.id === active) ? active
    : savedId && (!videos.length || videos.some(video => video.id === savedId)) ? savedId : videos[0]?.id;
  useEffect(() => {
    work.current?.abort(); work.current = null; setWorking(false);
    setSource(null); setError(''); setPreviews({}); setFailedImages({}); setNearby(false); setCollapsed(false); setCandidate(null);
    if (!mediaId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>, reading = false;
    const read = async () => {
      if (reading) return;
      reading = true; clearTimeout(timer);
      try {
        const response = await fetch(`/api/video/review-sources?mediaId=${encodeURIComponent(mediaId)}`, { cache: 'no-store', signal: controller.signal });
        const next: ReviewSource & { error?: string } = await response.json().catch(error => { if (response.ok) throw error; return {}; });
        if (!response.ok) throw Object.assign(new Error(next.error || 'Video material could not be loaded.'), { status: response.status });
        if (controller.signal.aborted) return;
        setSource(next); setError('');
        if (!next.status || !['COMPLETE', 'FAILED', 'RETRY_REQUIRED'].includes(next.status.phase)) timer = setTimeout(read, next.status ? 3000 : 10000);
      } catch (failure) { if (!controller.signal.aborted) setError(reviewRequestFailure(failure, 'video material')); }
      finally { reading = false; }
    };
    void read(); window.addEventListener('focus', read);
    return () => { work.current?.abort(); controller.abort(); clearTimeout(timer); window.removeEventListener('focus', read); };
  }, [mediaId, refresh]);
  const review = source?.status?.phase === 'COMPLETE' && source.review?.video.locator.sourceVideoMediaId === mediaId ? source.review : null;
  const matching = review && JSON.stringify(draft.state.choices?.video) === JSON.stringify(review.video);
  const frames = matching ? draft.state.choices?.frames ?? [] : [];
  const blocked = disabled || Boolean(draft.state.error || draft.state.conflict || draft.state.saved?.issues.length);
  const blockingReason = disabled ? 'Frame selection is paused while portfolio generation is active. Stop or finish generation to edit.'
    : draft.state.error || (draft.state.conflict ? 'Reload saved review to read the latest revision before selecting more frames.'
      : draft.state.saved?.issues.length ? 'Saved material is unavailable or changed. Reload saved review or remove unavailable material below. Saved choices are preserved.' : '');
  const selected = (frame: VideoCandidateFrameBinding) => frames.some(item => item.frameId === frame.frameId);
  const choose = (frame: VideoCandidateFrameBinding) => review && !blocked && void draft.update(review.video,
    choices => ({ ...choices, frames: toggleReviewFrame(choices.frames, frame) }));
  const previewIndexes = review ? [...new Set([...frames.map(frame => frame.candidateIndex), ...(candidate === null ? [] : [candidate])])]
    .filter(index => !review.library.representativeFrames.some(frame => frame.candidateIndex === index)) : [];
  const neighborBindings = [...frames.filter(frame => !review?.library.representativeFrames.some(item => item.candidateIndex === frame.candidateIndex)),
    ...(candidate === null || frames.some(frame => frame.candidateIndex === candidate) ? [] : review?.frameBindings.filter(frame => frame.candidateIndex === candidate) ?? [])];
  useEffect(() => {
    setPreviewBusy(false);
    if (!review || !previewIndexes.length) return;
    const controller = new AbortController(); setPreviewBusy(true);
    // Serial bounded batches share preprocessing; retained previews avoid work when choices change.
    const missing = previewIndexes.filter(index => {
      const binding = review.frameBindings.find(frame => frame.candidateIndex === index);
      return !binding || !previews[binding.frameId];
    });
    // Let an issued read settle: aborting HTTP does not stop server FFmpeg work. Ignore stale results and queue the next batch.
    const previous = previewWork.current;
    previewWork.current = (async () => { await previous; for (let offset = 0; offset < missing.length; offset += MAX_REVIEW_PREVIEW_BATCH) {
      if (controller.signal.aborted) break;
      const indexes = missing.slice(offset, offset + MAX_REVIEW_PREVIEW_BATCH);
      try {
        const bindings = indexes.map(index => {
          const binding = review.frameBindings.find(frame => frame.candidateIndex === index);
          const saved = frames.find(frame => frame.candidateIndex === index);
          if (!binding || (saved && JSON.stringify(saved) !== JSON.stringify(binding))) throw new Error('Nearby frame changed. Reload the saved review.');
          return binding;
        });
        const response = await fetch(`/api/video/review-sources?mediaId=${encodeURIComponent(mediaId!)}&candidateIndexes=${indexes.join(',')}`,
          { cache: 'no-store' });
        const next: ReviewSource & { error?: string } = await response.json().catch(error => { if (response.ok) throw error; return {}; });
        if (!response.ok) throw Object.assign(new Error(next.error || 'Nearby frames unavailable.'), { status: response.status });
        if (!controller.signal.aborted) {
          if (JSON.stringify(next.review?.video) !== JSON.stringify(review.video)) throw new Error('Video source changed. Reload the saved review.');
          const loaded = next.review?.previews;
          if (!loaded || loaded.length !== bindings.length || bindings.some(binding => !loaded.some(preview =>
            preview.providerEligible === false && JSON.stringify(preview.binding) === JSON.stringify(binding)))) {
            throw new Error('Nearby frames changed. Reload the saved review.');
          }
          setPreviews(current => ({ ...current, ...Object.fromEntries(loaded.map(preview => [preview.binding.frameId, preview])) }));
        }
      } catch (failure) { if (!controller.signal.aborted) setError(reviewRequestFailure(failure, 'video material')); }
    } })().finally(() => { if (!controller.signal.aborted) setPreviewBusy(false); });
    return () => controller.abort();
  }, [JSON.stringify(previewIndexes), mediaId, review, previewRetry]);
  const selectedClaims = draft.state.choices?.claims?.filter(reference => matching || !reference.type.startsWith('VIDEO_')) ?? [];
  const prepare = async () => {
    if (disabled || work.current || !source || source.status?.busy || source.status?.phase === 'FAILED') return;
    const controller = new AbortController(); work.current = controller; setWorking(true); setError('');
    try {
      await runVideoIntelligence(source.status ? { action: source.status.phase === 'RETRY_REQUIRED' ? 'RETRY' : 'ADVANCE', locator: source.status.locator }
        : { action: 'START', mediaId: mediaId! }, { signal: controller.signal,
        onStatus: status => setSource(current => current ? { ...current, status } : current) });
      if (!controller.signal.aborted) setRefresh(value => value + 1);
    } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
    finally { if (work.current === controller) { work.current = null; setWorking(false); } }
  };
  if (!mediaId) return null;
  const retryPreview = (binding: VideoCandidateFrameBinding) => {
    setError(''); setFailedImages(current => ({ ...current, [binding.frameId]: false }));
    setPreviews(current => { const next = { ...current }; delete next[binding.frameId]; return next; });
    setPreviewRetry(value => value + 1);
  };
  const frameChoice = (binding: VideoCandidateFrameBinding, thumbnail?: string) => <div key={binding.frameId}
    className={styles.frame} data-frame-id={binding.frameId}>
    <label>
      {thumbnail && !failedImages[binding.frameId] ? <img src={thumbnail} alt={`Video frame at ${reviewTime(binding.timestampMs)}`}
        onError={() => setFailedImages(current => ({ ...current, [binding.frameId]: true }))} />
        : <div className={styles.placeholder}>Preview unavailable</div>}
      <span><input type="checkbox" checked={selected(binding)} disabled={blocked}
        onChange={() => choose(binding)} /> {reviewTime(binding.timestampMs)} · {binding.timestampMs} ms</span>
    </label>
    <code>{binding.frameId}</code>
    {(!thumbnail || failedImages[binding.frameId]) ? <button type="button" disabled={previewBusy}
      onClick={() => retryPreview(binding)}>Retry preview</button> : null}
  </div>;
  return <section className={`panel ${styles.card}`} aria-label="Video material review">
    {videos.length > 1 ? <label>Video <select value={mediaId} disabled={disabled || draft.state.pending > 0} onChange={event => { setActive(event.target.value); setCandidate(null); }}>
      {videos.map(video => <option key={video.id} value={video.id}>{video.name}</option>)}
    </select></label> : null}
    <div className={styles.heading}><strong>{review ? collapsed ? `Video material · ${frames.length} frames · ${selectedClaims.length} statements` : 'Video material ready' : 'Video material'}</strong>
      <span role="status">{draft.state.pending ? 'Saving…' : draft.state.conflict ? 'Conflict / reload required' : draft.state.error ? 'Save failed'
        : matching && draft.state.saved ? 'Saved ✓' : ''}</span>
      {review ? <button type="button" className="button button-secondary" disabled={!collapsed && !draft.canGenerate()}
        onClick={() => setCollapsed(!collapsed)}>{collapsed ? 'Edit' : 'Collapse'}</button> : null}</div>
    {error ? <div role="alert"><p>{error}</p>
      <button type="button" disabled={disabled || working} onClick={() => setRefresh(value => value + 1)}>Reload video material</button>
    </div> : null}
    {blockingReason ? <p role="status">{blockingReason}</p> : null}
    {!review ? <>
      <p role="status">{!source ? error ? 'Video material unavailable. Reload it or replace the video.' : 'Loading video material…' : !source.status ? 'Video preparation has not started.'
        : source.status.phase === 'FAILED' ? `Preparation failed: ${source.status.failure?.message ?? 'Source could not be prepared.'}`
        : source.status.phase === 'RETRY_REQUIRED' ? `Retry required: ${source.status.retry?.message ?? 'Previous work was not completed.'}`
        : `Video preparation: ${preparationLabel[source.status.phase]} · ${source.status.completedRepresentatives} / ${source.status.totalRepresentatives ?? '?'} scenes`}</p>
      {source?.status?.phase === 'FAILED' ? <p>Remove this video and upload a replacement, or inspect the failure in Video Intelligence.</p> : null}
      {source && source.status?.phase !== 'FAILED' ? <button type="button" disabled={disabled || working || source.status?.busy}
        onClick={() => void prepare()}>{working || source.status?.busy ? 'Preparing video…' : !source.status ? 'Prepare video'
          : source.status.phase === 'RETRY_REQUIRED' ? 'Retry video preparation' : 'Resume video preparation'}</button> : null}
      {source?.status?.phase === 'RETRY_REQUIRED' ? <p>Retry may make another paid analysis call.</p> : null}
    </> : !collapsed ? <>
      <p>Choose frames and statements for generation</p>
      <div className={styles.heading}><strong>Frames</strong><span>{frames.length} selected</span></div>
      <div className={styles.frames}>{review.library.representativeFrames.map(frame => frameChoice(
        review.frameBindings.find(binding => binding.candidateIndex === frame.candidateIndex)!, frame.thumbnailDataUrl))}
        {neighborBindings.map(binding => frameChoice(binding, previews[binding.frameId]?.thumbnailDataUrl))}</div>
      <p className={styles.metadata}>{frames.length ? 'Selected frames form the candidate pool for generation.' : 'No frames selected = let AI choose automatically'}</p>
      <button type="button" className="button button-secondary" onClick={() => setNearby(!nearby)}>View nearby frames</button>
      {nearby ? <div className={styles.nearby}>
        {review.frameBindings.filter(binding => !review.library.representativeFrames.some(frame => frame.candidateIndex === binding.candidateIndex))
          .map(binding => <button key={binding.frameId} type="button" className="button button-secondary" disabled={previewBusy}
            onClick={() => { setError(''); setCandidate(binding.candidateIndex); }}>Preview {reviewTime(binding.timestampMs)}</button>)}
        {previewBusy ? <span role="status">Loading nearby frame…</span> : null}
      </div> : null}
      <VideoReviewStatements review={review} draft={draft} disabled={blocked} />
    </> : null}
    <a className={styles.advanced} href={`/studio/video?mediaId=${encodeURIComponent(mediaId)}`}>Advanced Video Intelligence →</a>
  </section>;
}
