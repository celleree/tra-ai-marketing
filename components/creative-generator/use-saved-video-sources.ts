'use client';

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { CreativeSourceAsset, CreativeSourceVideoAsset } from '@/lib/media/types';
import type { useVideoReviewDraft } from './use-video-review-draft';

const INVENTORY = 'tra-create-video-ids-v1';
/** Convenience IDs only. Reopen rehydrates current server media without advancing video work. */
export function useSavedVideoSources(sources: CreativeSourceAsset[], setSources: Dispatch<SetStateAction<CreativeSourceAsset[]>>,
  review: ReturnType<typeof useVideoReviewDraft>) {
  const [pending, setPending] = useState(true), [failures, setFailures] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const removed = useRef(new Set<string>()), current = useRef(sources), loaded = useRef(false);
  current.current = sources;
  const savedId = review.state.choices?.video?.locator.sourceVideoMediaId;
  useEffect(() => {
    if (!review.restored) return;
    const controller = new AbortController();
    let ids: string[] = [];
    try { const value: unknown = JSON.parse(window.localStorage.getItem(INVENTORY) ?? '[]');
      if (Array.isArray(value)) ids = value.filter(id => typeof id === 'string' && /^media_[a-f0-9]{32}$/.test(id));
    } catch { /* Saved review still restores its selected video. */ }
    if (savedId) ids.push(savedId);
    setPending(true);
    void Promise.all([...new Set(ids)].filter(id => !removed.current.has(id) && !current.current.some(source => source.media.id === id))
      .map(async id => {
        try {
          const response = await fetch(`/api/video/intelligence/jobs?mediaId=${encodeURIComponent(id)}`, { cache: 'no-store', signal: controller.signal });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Video unavailable.');
          const media = result.source as CreativeSourceVideoAsset;
          if (media?.id !== id || media.mediaType !== 'VIDEO') throw new Error('Saved video identity is invalid.');
          if (!controller.signal.aborted && !removed.current.has(id)) setSources(existing => existing.some(source => source.media.id === id)
            ? existing : [...existing, { role: 'TRA_VIDEO', media }]);
          return [id, ''] as const;
        } catch (error) { return [id, error instanceof Error ? error.message : 'Video unavailable.'] as const; }
      })).then(results => {
        if (controller.signal.aborted) return;
        setFailures(Object.fromEntries(results.filter(([id, error]) => error && !removed.current.has(id))));
        loaded.current = true; setPending(false);
      });
    return () => controller.abort();
  }, [review.restored, savedId, attempt]);
  useEffect(() => {
    if (!loaded.current || pending) return;
    try { window.localStorage.setItem(INVENTORY, JSON.stringify([...new Set([
      ...sources.filter(source => source.role === 'TRA_VIDEO').map(source => source.media.id), ...Object.keys(failures),
    ])])); } catch { /* Inventory convenience storage may be disabled. */ }
  }, [sources, failures, pending]);
  const forget = (id: string) => { removed.current.add(id); };
  const clearUnavailable = async () => {
    for (const id of Object.keys(failures)) { forget(id); await review.removeVideo(id); }
    setFailures({});
  };
  return { pending, error: Object.values(failures).join(' '), forget, clearUnavailable, reload: () => setAttempt(value => value + 1) };
}
