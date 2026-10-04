'use client';

import { useEffect, useRef, useState } from 'react';
import { createReviewDraftClient, EMPTY_REVIEW_CLIENT_STATE, rememberReviewDraft, replaceReviewVideo,
  reviewDraftIdForReopen } from '@/lib/video/review-selection-client';
import type { ReviewVideoReference } from '@/lib/video/review-selection';

/** Owned by Create, above the future panel: hiding/unmounting that panel cannot clear saved choices. */
export function useVideoReviewDraft() {
  const [state, setState] = useState(EMPTY_REVIEW_CLIENT_STATE);
  const mounted = useRef(false);
  const lastId = useRef<string | null>(null);
  const restoring = useRef<Promise<unknown>>(Promise.resolve());
  const client = useRef<ReturnType<typeof createReviewDraftClient> | null>(null);
  if (!client.current) client.current = createReviewDraftClient({
    onChange: next => { if (mounted.current) setState(next); },
    onSaved: id => {
      lastId.current = id;
      if (!mounted.current) return;
      try { rememberReviewDraft(id, window.localStorage); } catch { /* Storage can be disabled. */ }
      const url = new URL(window.location.href); url.searchParams.set('review', id);
      window.history.replaceState(null, '', url);
    },
  });
  useEffect(() => {
    mounted.current = true;
    const url = new URL(window.location.href);
    let id: string | null;
    try { id = reviewDraftIdForReopen(url, window.localStorage); } catch { id = reviewDraftIdForReopen(url); }
    lastId.current = id;
    if (id !== null) restoring.current = client.current!.load(id).catch(() => undefined);
    return () => { mounted.current = false; };
  }, []);
  const replaceVideo = async (video: ReviewVideoReference | null) => {
    await restoring.current;
    const choices = client.current!.getState().choices;
    if (choices) return client.current!.save(replaceReviewVideo(choices, video)).catch(() => undefined);
  };
  const removeVideo = async (mediaId: string) => {
    await restoring.current;
    if (client.current!.getState().choices?.video?.locator.sourceVideoMediaId === mediaId) return replaceVideo(null);
  };
  return { state, save: client.current.save, reload: () => {
    const id = lastId.current;
    if (id) return client.current!.load(id).catch(() => undefined);
  }, replaceVideo, removeVideo };
}
