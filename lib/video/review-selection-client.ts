import type { ReviewSelectionChoices, ReviewVideoReference } from '@/lib/video/review-selection';
import type { loadVideoReviewDraft } from '@/lib/video/review-selection-store';

export type ReviewDraftResponse = Awaited<ReturnType<typeof loadVideoReviewDraft>>;
export type ReviewDraftClientState = { saved: ReviewDraftResponse | null; choices: ReviewSelectionChoices | null;
  pending: number; error: string; conflict: boolean };
export const LAST_VIDEO_REVIEW = 'tra-video-review-draft-v1';
export const EMPTY_REVIEW_CLIENT_STATE: ReviewDraftClientState = { saved: null, choices: null, pending: 0, error: '', conflict: false };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

/** Browser storage contains only a convenience ID, never authoritative choices or revisions. */
export const reviewDraftIdForReopen = (url: URL, storage?: Storage) => {
  if (url.searchParams.has('review')) return url.searchParams.get('review');
  if (url.searchParams.has('draft')) return url.searchParams.get('draft');
  try { return storage?.getItem(LAST_VIDEO_REVIEW) ?? null; } catch { return null; }
};
export const rememberReviewDraft = (id: string, storage?: Storage) => {
  try { storage?.setItem(LAST_VIDEO_REVIEW, id); } catch { /* Explicit URL still restores the draft. */ }
};
export const replaceReviewVideo = (choices: ReviewSelectionChoices, video: ReviewVideoReference | null): ReviewSelectionChoices => {
  if (JSON.stringify(choices.video) === JSON.stringify(video)) return structuredClone(choices);
  return { ...structuredClone(choices), video, frames: choices.frames === null ? null : [],
    claims: choices.claims === null ? null : choices.claims.filter(claim => !claim.type.startsWith('VIDEO_')) };
};

/** One queue owns server revisions. A failed/uncertain write requires a server reload before any further save. */
export const createReviewDraftClient = (options: { request?: typeof fetch; onChange?: (state: ReviewDraftClientState) => void;
  onSaved?: (id: string) => void; onCreated?: (id: string) => void; createId?: () => string } = {}) => {
  let state = structuredClone(EMPTY_REVIEW_CLIENT_STATE), tail = Promise.resolve(), blocked = false, edit = 0;
  let draftId: string | null = null;
  const publish = (patch: Partial<ReviewDraftClientState>) => {
    state = { ...state, ...patch }; options.onChange?.(structuredClone(state));
  };
  const request = async (url: string, body?: unknown): Promise<ReviewDraftResponse> => {
    const response = await (options.request ?? fetch)(url, { cache: 'no-store', ...(body === undefined ? {} :
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Review draft request failed.'), { status: response.status });
    return result as ReviewDraftResponse;
  };
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    publish({ pending: state.pending + 1 });
    const result = tail.then(task).catch(error => {
      blocked = true;
      publish({ error: `${error instanceof Error ? error.message : 'Review draft request failed.'} Reload the saved review before saving again.`,
        conflict: (error as { status?: number }).status === 409 || state.conflict });
      throw error;
    }).finally(() => publish({ pending: state.pending - 1 }));
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const load = (id: string) => {
    draftId = id;
    const version = ++edit;
    return enqueue(async () => {
      if (!/^review_[a-f0-9]{32}$/.test(id)) throw new Error('Review draft ID is invalid.');
      const saved = await request(`/api/video/review-selection?id=${encodeURIComponent(id)}`);
      blocked = false;
      publish({ saved, ...(edit === version ? { choices: saved.draft.choices } : {}), error: '', conflict: false });
      options.onSaved?.(saved.draft.id); return saved;
    });
  };
  const save = (choices: ReviewSelectionChoices) => {
    if (!draftId) {
      draftId = (options.createId ?? (() => `review_${crypto.randomUUID().replaceAll('-', '')}`))();
      options.onCreated?.(draftId);
    }
    const snapshot = structuredClone(choices), version = ++edit;
    publish({ choices: snapshot });
    return enqueue(async () => {
      if (blocked) throw new Error('Review state needs a server reload.');
      const saved = await request('/api/video/review-selection', { id: state.saved?.draft.id ?? draftId,
        expectedRevision: state.saved?.revision ?? null, choices: snapshot });
      publish({ saved, ...(edit === version ? { choices: saved.draft.choices } : {}), error: '', conflict: false });
      options.onSaved?.(saved.draft.id); return saved;
    });
  };
  const recover = () => enqueue(async () => {
    if (!draftId) return;
    try {
      const saved = await request(`/api/video/review-selection?id=${encodeURIComponent(draftId)}`);
      blocked = false; publish({ saved, choices: saved.draft.choices, error: '', conflict: false });
      options.onSaved?.(saved.draft.id);
    } catch (error) {
      // A first write may never have reached storage. Keep visible choices for an explicit retry.
      if (state.saved || (error as { status?: number }).status !== 404) throw error;
      blocked = false; publish({ error: '', conflict: false });
    }
  });
  return { load, save, recover, getState: () => structuredClone(state) };
};
