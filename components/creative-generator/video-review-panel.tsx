'use client';

import { useEffect, useState } from 'react';
import type { discoverVideoReviewSource } from '@/lib/video/review-source-discovery';
import type { VideoCandidateFrameBinding } from '@/lib/video/generation-selection-contract';
import type { useVideoReviewDraft } from './use-video-review-draft';
import styles from './video-review-panel.module.css';
import { VideoReviewStatements } from './video-review-statements';

export type ReviewSource = Awaited<ReturnType<typeof discoverVideoReviewSource>>;
export const reviewTime = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000) % 60 < 10 ? '0' : ''}${Math.floor(ms / 1000) % 60}`;
export const toggleReviewFrame = (frames: VideoCandidateFrameBinding[] | null, frame: VideoCandidateFrameBinding) => {
  const current = frames ?? [];
  return current.some(item => item.frameId === frame.frameId) ? current.filter(item => item.frameId !== frame.frameId)
    : current.length < 3 ? [...current, frame] : current;
};

export function VideoReviewPanel({ videos, draft, disabled = false }: { videos: Array<{ id: string; name: string }>;
  draft: ReturnType<typeof useVideoReviewDraft>; disabled?: boolean }) {
  const [active, setActive] = useState(''), [source, setSource] = useState<ReviewSource | null>(null);
  const [error, setError] = useState(''), [collapsed, setCollapsed] = useState(false);
  const [nearby, setNearby] = useState(false), [previews, setPreviews] = useState<Record<string, NonNullable<NonNullable<ReviewSource['review']>['preview']>>>({});
  const [previewBusy, setPreviewBusy] = useState(false);
  const savedId = draft.state.choices?.video?.locator.sourceVideoMediaId;
  const mediaId = videos.some(video => video.id === active) ? active
    : savedId && (!videos.length || videos.some(video => video.id === savedId)) ? savedId : videos[0]?.id;
  useEffect(() => {
    setSource(null); setError(''); setPreviews({}); setNearby(false); setCollapsed(false); setCandidate(null);
    if (!mediaId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>, reading = false;
    const read = async () => {
      if (reading) return;
      reading = true; clearTimeout(timer);
      try {
        const response = await fetch(`/api/video/review-sources?mediaId=${encodeURIComponent(mediaId)}`, { cache: 'no-store', signal: controller.signal });
        const next: ReviewSource & { error?: string } = await response.json();
        if (!response.ok) throw new Error(next.error || 'Video material could not be loaded.');
        if (controller.signal.aborted) return;
        setSource(next);
        if (!next.status || !['COMPLETE', 'FAILED', 'RETRY_REQUIRED'].includes(next.status.phase)) timer = setTimeout(read, next.status ? 3000 : 10000);
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Video material could not be loaded.'); }
      finally { reading = false; }
    };
    void read(); window.addEventListener('focus', read);
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener('focus', read); };
  }, [mediaId]);
  const review = source?.status?.phase === 'COMPLETE' && source.review?.video.locator.sourceVideoMediaId === mediaId ? source.review : null;
  const matching = review && JSON.stringify(draft.state.choices?.video) === JSON.stringify(review.video);
  const frames = matching ? draft.state.choices?.frames ?? [] : [];
  const blocked = disabled || Boolean(draft.state.error || draft.state.conflict || draft.state.saved?.issues.length);
  const selected = (frame: VideoCandidateFrameBinding) => frames.some(item => item.frameId === frame.frameId);
  const choose = (frame: VideoCandidateFrameBinding) => review && !blocked && void draft.update(review.video,
    choices => ({ ...choices, frames: toggleReviewFrame(choices.frames, frame) }));
  const [candidate, setCandidate] = useState<number | null>(null);
  const previewIndexes = review ? [...new Set([...frames.map(frame => frame.candidateIndex), ...(candidate === null ? [] : [candidate])])]
    .filter(index => !review.library.representativeFrames.some(frame => frame.candidateIndex === index)) : [];
  useEffect(() => {
    setPreviewBusy(false);
    if (!review || !previewIndexes.length) return;
    const controller = new AbortController(); setPreviewBusy(true);
    void Promise.all(previewIndexes.map(async index => {
      const binding = review.frameBindings.find(frame => frame.candidateIndex === index)!;
      if (previews[binding.frameId]) return;
      try {
        const response = await fetch(`/api/video/review-sources?mediaId=${encodeURIComponent(mediaId!)}&candidateIndex=${index}`,
          { cache: 'no-store', signal: controller.signal });
        const next: ReviewSource & { error?: string } = await response.json();
        if (!response.ok) throw new Error(next.error || 'Nearby frame unavailable.');
        if (!controller.signal.aborted) {
          if (JSON.stringify(next.review?.video) !== JSON.stringify(review.video)) throw new Error('Video source changed. Reload the saved review.');
          const preview = next.review?.preview;
          if (!preview || JSON.stringify(preview.binding) !== JSON.stringify(binding)) throw new Error('Nearby frame changed. Reload the saved review.');
          setPreviews(current => ({ ...current, [binding.frameId]: preview }));
        }
      } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
    })).finally(() => { if (!controller.signal.aborted) setPreviewBusy(false); });
    return () => controller.abort();
  }, [JSON.stringify(previewIndexes), mediaId, review]);
  if (!mediaId) return null;
  const frameChoice = (binding: VideoCandidateFrameBinding, thumbnail: string) => <label key={binding.frameId} className={styles.frame}>
    <img src={thumbnail} alt={`Video frame at ${reviewTime(binding.timestampMs)}`} />
    <span><input type="checkbox" checked={selected(binding)} disabled={blocked || (!selected(binding) && frames.length >= 3)}
      onChange={() => choose(binding)} /> {reviewTime(binding.timestampMs)}</span>
  </label>;
  return <section className={`panel ${styles.card}`} aria-label="Video material review">
    {videos.length > 1 ? <label>Video <select value={mediaId} disabled={disabled || draft.state.pending > 0} onChange={event => { setActive(event.target.value); setCandidate(null); }}>
      {videos.map(video => <option key={video.id} value={video.id}>{video.name}</option>)}
    </select></label> : null}
    <div className={styles.heading}><strong>{review ? collapsed ? `Video material · ${frames.length} frames · ${matching ? draft.state.choices?.claims?.length ?? 0 : 0} statements` : 'Video material ready' : 'Video material'}</strong>
      <span role="status">{draft.state.pending ? 'Saving…' : draft.state.conflict ? 'Conflict / reload required' : draft.state.error ? 'Save failed'
        : matching && draft.state.saved ? 'Saved ✓' : ''}</span>
      {review ? <button type="button" className="button button-secondary" disabled={!collapsed && !draft.canGenerate()}
        onClick={() => setCollapsed(!collapsed)}>{collapsed ? 'Edit' : 'Collapse'}</button> : null}</div>
    {error ? <p role="alert">{error}</p> : null}
    {!review ? <p>{source ? 'Video analysis is not complete.' : 'Loading video material…'}</p> : !collapsed ? <>
      <p>Choose frames and statements for generation</p>
      <div className={styles.heading}><strong>Frames</strong><span>{frames.length} / 3 selected</span></div>
      <div className={styles.frames}>{review.library.representativeFrames.map(frame => frameChoice(
        review.frameBindings.find(binding => binding.candidateIndex === frame.candidateIndex)!, frame.thumbnailDataUrl))}
        {Object.values(previews).filter(preview => selected(preview.binding) || preview.binding.candidateIndex === candidate)
          .map(preview => frameChoice(preview.binding, preview.thumbnailDataUrl))}</div>
      <p className={styles.metadata}>{frames.length >= 3 ? 'Three frames selected. Deselect one to choose another.' : 'No frames selected = let AI choose automatically'}</p>
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
