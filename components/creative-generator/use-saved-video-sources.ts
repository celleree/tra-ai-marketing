'use client';

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { CreativeSourceAsset, CreativeSourceVideoAsset } from '@/lib/media/types';
import type { useVideoReviewDraft } from './use-video-review-draft';
import type { ReferenceLibraryItem } from '@/lib/references/types';
import type { WorkspaceAccessObserver } from '@/lib/auth/workspace-access-client';

const INVENTORY = 'tax-marketing-studio-create-video-ids-v1';
const LINKED_LAYOUTS = 'tax-marketing-studio-create-linked-layout-ids-v1';
/** Convenience IDs only. Reopen rehydrates current server media without advancing video work. */
export function useSavedVideoSources(sources: CreativeSourceAsset[], setSources: Dispatch<SetStateAction<CreativeSourceAsset[]>>,
  review: ReturnType<typeof useVideoReviewDraft>, observeAccess?: WorkspaceAccessObserver) {
  const [pending, setPending] = useState(true), [failures, setFailures] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const removed = useRef(new Set<string>()), current = useRef(sources), loaded = useRef(false);
  const linkedLayouts = useRef(new Set<string>());
  current.current = sources;
  const savedId = review.state.choices?.video?.locator.sourceVideoMediaId;
  useEffect(() => {
    if (!review.restored) return;
    const controller = new AbortController();
    let ids: string[] = [];
    try { const value: unknown = JSON.parse(window.localStorage.getItem(INVENTORY) ?? '[]');
      if (Array.isArray(value)) ids = value.filter(id => typeof id === 'string' && /^media_[a-f0-9]{32}$/.test(id));
    } catch { /* Saved review still restores its selected video. */ }
    try { const value: unknown = JSON.parse(window.localStorage.getItem(LINKED_LAYOUTS) ?? '[]');
      if (Array.isArray(value)) value.filter(id => typeof id === 'string' && /^media_[a-f0-9]{32}$/.test(id))
        .forEach(id => linkedLayouts.current.add(id));
    } catch { /* An explicit layout link still works. */ }
    if (savedId) ids.push(savedId);
    const linkedUrl = new URL(window.location.href), linkedId = linkedUrl.searchParams.get('videoMediaId');
    if (linkedId && /^media_[a-f0-9]{32}$/.test(linkedId)) {
      ids.push(linkedId);
      try {
        window.localStorage.setItem(INVENTORY, JSON.stringify([...new Set(ids)]));
        linkedUrl.searchParams.delete('videoMediaId');
      } catch { /* Keep the URL identity when convenience storage is disabled. */ }
    }
    const layoutId = linkedUrl.searchParams.get('layoutMediaId');
    if (layoutId && /^media_[a-f0-9]{32}$/.test(layoutId)) {
      linkedLayouts.current.add(layoutId);
      try {
        window.localStorage.setItem(LINKED_LAYOUTS, JSON.stringify([...linkedLayouts.current]));
        linkedUrl.searchParams.delete('layoutMediaId');
      } catch { /* Keep the URL identity until it can survive refresh. */ }
    }
    if (linkedUrl.href !== window.location.href) window.history.replaceState(null, '', linkedUrl);
    const layouts = [...linkedLayouts.current].filter(id => !removed.current.has(id)
      && !current.current.some(source => source.media.id === id));
    const loadLayouts = async () => {
      if (!layouts.length) return [];
      try {
        const response = await fetch('/api/references', { cache: 'no-store', signal: controller.signal });
        if (!controller.signal.aborted) observeAccess?.('saved-layouts', response.status);
        const value = await response.json();
        if (!response.ok || !Array.isArray(value.items)) throw new Error('Saved layout references could not be loaded.');
        return layouts.map(id => {
          const item = (value.items as ReferenceLibraryItem[]).find(item => item.id === id && item.referenceType === 'layout');
          if (!item) return [id, 'Saved layout reference is unavailable.'] as const;
          if (!controller.signal.aborted && !removed.current.has(id)) setSources(existing => existing.some(source => source.media.id === id)
            ? existing : [...existing, { role: 'LAYOUT_REFERENCE', media: { ...item, mediaType: 'IMAGE' } }]);
          return [id, ''] as const;
        });
      } catch (error) { return layouts.map(id => [id, error instanceof Error ? error.message : 'Layout unavailable.'] as const); }
    };
    setPending(true);
    void Promise.all([loadLayouts(), ...[...new Set(ids)].filter(id => !removed.current.has(id) && !current.current.some(source => source.media.id === id))
      .map(async id => {
        try {
          const response = await fetch(`/api/video/intelligence/jobs?mediaId=${encodeURIComponent(id)}`, { cache: 'no-store', signal: controller.signal });
          if (!controller.signal.aborted) observeAccess?.('saved-video:' + id, response.status);
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Video unavailable.');
          const media = result.source as CreativeSourceVideoAsset;
          if (media?.id !== id || media.mediaType !== 'VIDEO') throw new Error('Saved video identity is invalid.');
          if (!controller.signal.aborted && !removed.current.has(id)) setSources(existing => existing.some(source => source.media.id === id)
            ? existing : [...existing, { role: 'TRA_VIDEO', media }]);
          return [id, ''] as const;
        } catch (error) { return [id, error instanceof Error ? error.message : 'Video unavailable.'] as const; }
      })]).then(([layoutResults, ...videoResults]) => {
        if (controller.signal.aborted) return;
        const results = [...layoutResults, ...videoResults];
        setFailures(Object.fromEntries(results.filter(([id, error]) => error && !removed.current.has(id))));
        loaded.current = true; setPending(false);
      });
    return () => controller.abort();
  }, [review.restored, savedId, attempt]);
  useEffect(() => {
    if (!loaded.current || pending) return;
    try { window.localStorage.setItem(INVENTORY, JSON.stringify([...new Set([
      ...sources.filter(source => source.role === 'TRA_VIDEO').map(source => source.media.id),
      ...Object.keys(failures).filter(id => !linkedLayouts.current.has(id)),
    ])]));
      if (linkedLayouts.current.size) window.localStorage.setItem(LINKED_LAYOUTS, JSON.stringify([...new Set([
        ...sources.filter(source => source.role === 'LAYOUT_REFERENCE' && linkedLayouts.current.has(source.media.id)).map(source => source.media.id),
        ...Object.keys(failures).filter(id => linkedLayouts.current.has(id)),
      ])]));
    } catch { /* Inventory convenience storage may be disabled. */ }
  }, [sources, failures, pending]);
  const forget = (id: string) => {
    removed.current.add(id);
    for (const key of [INVENTORY, LINKED_LAYOUTS]) {
      try {
        const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null');
        if (Array.isArray(value)) window.localStorage.setItem(key, JSON.stringify(value.filter(saved => saved !== id)));
      } catch { /* Other source reads may still be pending; remove each stored identity independently. */ }
    }
    const url = new URL(window.location.href);
    for (const key of ['videoMediaId', 'layoutMediaId']) if (url.searchParams.get(key) === id) url.searchParams.delete(key);
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  };
  const clearUnavailable = async () => {
    for (const id of Object.keys(failures)) { forget(id); await review.removeVideo(id); }
    setFailures({});
  };
  return { pending, error: Object.values(failures).join(' '), forget, clearUnavailable, reload: () => setAttempt(value => value + 1) };
}
