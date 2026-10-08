'use client';

import { useEffect, useRef, useState } from 'react';
import { createReviewDraftClient, EMPTY_REVIEW_CLIENT_STATE, rememberReviewDraft, replaceReviewVideo,
  reviewDraftIdForReopen } from '@/lib/video/review-selection-client';
import { readStoredRuntimeCompanyProfile } from '@/lib/company/creative-context';
import type { ReviewSelectionChoices, ReviewVideoReference } from '@/lib/video/review-selection';

/** Owned by Create, above the future panel: hiding/unmounting that panel cannot clear saved choices. */
export function useVideoReviewDraft() {
  const [state, setState] = useState(EMPTY_REVIEW_CLIENT_STATE);
  const mounted = useRef(false);
  const lastId = useRef<string | null>(null);
  const restoring = useRef<Promise<unknown>>(Promise.resolve());
  const removedSources = useRef(new Set<string>());
  const initialized = useRef(false), editing = useRef(0);
  const client = useRef<ReturnType<typeof createReviewDraftClient> | null>(null);
  const persistId = (id: string) => {
    lastId.current = id;
    if (!mounted.current) return;
    try { rememberReviewDraft(id, window.localStorage); } catch { /* Storage can be disabled. */ }
    const url = new URL(window.location.href); url.searchParams.set('review', id);
    window.history.replaceState(null, '', url);
  };
  if (!client.current) client.current = createReviewDraftClient({
    onChange: next => { if (mounted.current) setState(next); }, onCreated: persistId, onSaved: persistId,
  });
  const restore = async (id: string) => {
    await client.current!.load(id);
    const choices = client.current!.getState().choices;
    if (choices?.video && removedSources.current.has(choices.video.locator.sourceVideoMediaId)) {
      await client.current!.save(replaceReviewVideo(choices, null));
    }
  };
  useEffect(() => {
    mounted.current = true;
    const refreshProfile = () => { if (mounted.current) setState(client.current!.getState()); };
    window.addEventListener('storage', refreshProfile); window.addEventListener('focus', refreshProfile);
    const url = new URL(window.location.href);
    let id: string | null;
    try { id = reviewDraftIdForReopen(url, window.localStorage); } catch { id = reviewDraftIdForReopen(url); }
    lastId.current = id;
    restoring.current = (id !== null ? restore(id) : Promise.resolve()).catch(() => undefined).finally(() => {
      initialized.current = true;
      if (mounted.current) setState(client.current!.getState());
    });
    return () => { mounted.current = false; window.removeEventListener('storage', refreshProfile); window.removeEventListener('focus', refreshProfile); };
  }, []);
  const finishEdit = () => {
    editing.current--;
    if (mounted.current) setState(client.current!.getState());
  };
  const update = (video: ReviewVideoReference, change: (choices: ReviewSelectionChoices) => ReviewSelectionChoices) => {
    editing.current++;
    return (async () => {
      await restoring.current;
      const current = client.current!.getState();
      if (current.error || current.conflict || removedSources.current.has(video.locator.sourceVideoMediaId)) return;
      const choices = current.choices ?? { video: null, frames: null, claims: null, companyProfile: null };
      await client.current!.save(change(replaceReviewVideo(choices, video)));
    })().catch(() => undefined).finally(finishEdit);
  };
  const profileChanged = () => {
    const saved = client.current!.getState().choices?.companyProfile;
    const canonical = (value: unknown): unknown => value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
    return Boolean(saved && JSON.stringify(canonical(saved)) !== JSON.stringify(canonical(readStoredRuntimeCompanyProfile() ?? null)));
  };
  const useCurrentProfile = async () => {
    editing.current++;
    try {
      await restoring.current;
      const current = client.current!.getState();
      if (!current.choices || current.pending || current.error || current.conflict) return;
      await client.current!.save({ ...current.choices, companyProfile: readStoredRuntimeCompanyProfile() ?? null,
        claims: current.choices.claims?.filter(claim => claim.type !== 'COMPANY_PROFILE') ?? null }).catch(() => undefined);
    } finally { finishEdit(); }
  };
  const canGenerate = () => {
    const current = client.current!.getState();
    return initialized.current && !profileChanged() && !editing.current && !current.pending && !current.error && !current.conflict
      && !current.saved?.issues.length && (!current.choices || Boolean(current.saved));
  };
  const replaceVideo = async (video: ReviewVideoReference | null) => {
    editing.current++;
    try {
      if (video) removedSources.current.delete(video.locator.sourceVideoMediaId);
      await restoring.current;
      const choices = client.current!.getState().choices;
      if (choices) return await client.current!.save(replaceReviewVideo(choices, video)).catch(() => undefined);
    } finally { finishEdit(); }
  };
  const removeVideo = async (mediaId: string) => {
    editing.current++;
    try {
      removedSources.current.add(mediaId);
      await restoring.current;
      if (client.current!.getState().choices?.video?.locator.sourceVideoMediaId === mediaId) return await replaceVideo(null);
    } finally { finishEdit(); }
  };
  const clearUnavailable = async () => {
    editing.current++;
    try {
      await restoring.current;
      const current = client.current!.getState();
      if (!current.choices || current.error || current.pending) return;
      const issues = current.saved?.issues ?? [];
      let choices = { ...current.choices, claims: current.choices.claims?.filter((_, index) =>
        !issues.some(issue => issue.source === 'CLAIM' && issue.index === index)) ?? null };
      if (issues.some(issue => issue.source === 'VIDEO')) choices = replaceReviewVideo(choices, null);
      await client.current!.save(choices).catch(() => undefined);
    } finally { finishEdit(); }
  };
  // Read the queue's settled revision, even when a save completed before React rerendered.
  const generationReference = () => {
    const saved = client.current!.getState().saved;
    return saved ? { draftId: saved.draft.id, revision: saved.revision } : undefined;
  };
  return { state, restored: initialized.current, profileChanged, useCurrentProfile, save: client.current.save, update, canGenerate, generationReference, clearUnavailable, reload: () => {
    const id = lastId.current;
    if (id) return restoring.current = (client.current!.getState().saved ? restore(id) : client.current!.recover().then(async () => {
      const current = client.current!.getState();
      if (current.choices?.video && removedSources.current.has(current.choices.video.locator.sourceVideoMediaId)) {
        await client.current!.save(replaceReviewVideo(current.choices, null));
      } else if (!current.saved && current.choices && !current.error) await client.current!.save(current.choices);
    })).catch(() => undefined);
  }, replaceVideo, removeVideo };
}
