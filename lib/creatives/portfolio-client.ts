import type { GenerateCreativeRequest } from '@/lib/creatives/generate-request';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import { parseCreative } from '@/lib/creatives/parse-generation-response';
import { parsePortfolioProgress, type PortfolioProgress } from '@/lib/creatives/portfolio-progress';
import { createSubmissionIdentity, SUBMISSION_HEADER, type SubmissionStorage } from '@/lib/creatives/submission-id';
import { PREVIEW_ADVANCE_HEADER, PREVIEW_TEST_APPROVAL } from '@/lib/creatives/preview-test-binding';

export type PortfolioResponse = { job: PortfolioProgress; creatives: GeneratedCreative[]; error?: string; retryAfterMs?: number;
  preflightReady?: true; previewOmitBrandLogo?: true; previewPreparationApproved?: true };
type Command = { action: 'create'; request: GenerateCreativeRequest; submissionId: string } | { action: 'load' | 'advance'; id: string }
  | { action: 'retry'; id: string; slotIndex: number | null };
const endpoint = '/api/creatives/portfolios';
const continuationKey = 'tra-preview-advance:' + PREVIEW_TEST_APPROVAL.id;
const stopPreviewContinuation = (id: string) => {
  if (id === PREVIEW_TEST_APPROVAL.portfolioId && typeof window !== 'undefined') {
    window.sessionStorage.setItem(continuationKey, 'stopped');
  }
};
const POLL_DELAY_MS = 2000;
const MAX_BUSY_RETRY_AFTER_MS = 30000;
const parseBusyRetryAfterMs = (value: string | null) => {
  const trimmed = value?.trim() ?? '';
  const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_BUSY_RETRY_AFTER_MS) : POLL_DELAY_MS;
};

/** Retain an unresolved browser submission across failed deliveries. */
export function createPortfolioSubmitter(storage?: () => SubmissionStorage) {
  const identity = createSubmissionIdentity('portfolio', storage);
  return async (request: GenerateCreativeRequest) => {
    const command = { action: 'create' as const, request: structuredClone(request),
      submissionId: await identity.forInput(JSON.stringify(request)) };
    const response = await requestPortfolio(command);
    identity.complete(command.submissionId);
    return response;
  };
}

export async function requestPortfolio(command: Command): Promise<PortfolioResponse> {
  try { return await requestPortfolioStep(command); }
  catch (error) {
    if (command.action !== 'create') stopPreviewContinuation(command.id);
    throw error;
  }
}

async function requestPortfolioStep(command: Command): Promise<PortfolioResponse> {
  const fenced = command.action !== 'create' && command.id === PREVIEW_TEST_APPROVAL.portfolioId;
  const session = fenced && typeof window !== 'undefined' ? window.sessionStorage : undefined;
  const previous = session?.getItem(continuationKey);
  const response = await fetch(command.action === 'load' ? endpoint + '?id=' + encodeURIComponent(command.id) : endpoint, {
    method: command.action === 'load' ? 'GET' : command.action === 'create' ? 'POST' : 'PATCH', cache: 'no-store',
    ...(command.action === 'load' && previous ? { headers: { [PREVIEW_ADVANCE_HEADER]: previous } } : {}),
    ...(command.action === 'load' ? {} : { headers: { 'Content-Type': 'application/json',
      ...(previous ? { [PREVIEW_ADVANCE_HEADER]: previous } : {}),
      ...(command.action === 'create' ? { [SUBMISSION_HEADER]: command.submissionId } : {}) },
      body: JSON.stringify(command.action === 'create' ? command.request : command) }),
  });
  const value = await response.json().catch(() => { throw new Error('Portfolio response was interrupted. Reload saved progress before resuming.'); });
  const job = parsePortfolioProgress(value?.job);
  if (!job || !Array.isArray(value.creatives)) throw new Error(typeof value?.error === 'string' ? value.error : 'Invalid portfolio response. Reload saved progress.');
  if (command.action === 'create' ? job.requestedCount !== command.request.variationCount : job.id !== command.id) {
    throw new Error('Portfolio response does not match the requested work. Reload saved progress.');
  }
  const creatives = value.creatives.map(parseCreative) as Array<GeneratedCreative | null>;
  if (creatives.some(creative => !creative || creative.finalization?.status !== 'SAVED'
    || job.slots[creative.index - 1]?.creativeId !== creative.id) || new Set(creatives.map(creative => creative!.id)).size !== creatives.length) {
    throw new Error('Invalid saved portfolio creatives. Reload saved progress.');
  }
  const error = typeof value.error === 'string' ? value.error : !response.ok ? 'Portfolio request failed. Reload saved progress.' : undefined;
  const retryAfterMs = response.status === 202 ? parseBusyRetryAfterMs(response.headers.get('Retry-After')) : undefined;
  if (fenced && command.action === 'advance' && response.status === 200 && !error && !job.lease && !job.planningError
    && !job.previewAcceptanceError && !job.slots.some(slot => ['RETRY_REQUIRED', 'BLOCKED'].includes(slot.status))) {
    if (value.previewPreparationApproved !== true || typeof value.previewAdvanceNonce !== 'string'
      || !/^[a-f0-9]{32}$/.test(value.previewAdvanceNonce)) throw new Error('Preview response was interrupted. Further work is not authorized.');
    session?.setItem(continuationKey, value.previewAdvanceNonce);
  }
  return { job, creatives: creatives as GeneratedCreative[], ...(value.preflightReady === true ? { preflightReady: true } : {}),
    ...(value.previewOmitBrandLogo === true ? { previewOmitBrandLogo: true } : {}),
    ...(value.previewPreparationApproved === true ? { previewPreparationApproved: true } : {}),
    ...(error ? { error } : {}), ...(retryAfterMs ? { retryAfterMs } : {}) };
}
export const portfolioCanAdvance = (job: PortfolioProgress, approvedPreview = false) =>
  !job.previewAcceptanceError && !(approvedPreview && job.slots.some(slot => ['RETRY_REQUIRED', 'BLOCKED'].includes(slot.status)))
  && (Boolean(job.lease) || (job.planReady ? job.slots.some(slot => slot.status === 'PENDING')
    : (!job.planningError || job.previewPreparationResume === true) && job.videoPreparation?.phase !== 'FAILED'));

/** Called only after Generate/Resume. Poll active work with GET; never retry a failed slot automatically. */
export async function runPortfolio(...args: Parameters<typeof runPortfolioSteps>) {
  try { return await runPortfolioSteps(...args); }
  catch (error) {
    if (args[0].previewPreparationApproved) stopPreviewContinuation(args[0].job.id);
    throw error;
  }
}

async function runPortfolioSteps(
  initial: PortfolioResponse, onUpdate: (value: PortfolioResponse) => void, shouldStop: () => boolean,
  wait: (delayMs: number) => Promise<void> = delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
) {
  if (initial.error) throw new Error(initial.error);
  if (initial.preflightReady) return initial;
  const approvedPreview = initial.previewPreparationApproved === true;
  let current = initial;
  while (!shouldStop() && portfolioCanAdvance(current.job, approvedPreview)) {
    const parentBusy = Boolean(current.job.lease && current.job.lease.expiresAtMs > Date.now());
    const polling = parentBusy || current.job.videoPreparation?.busy === true;
    if (polling) { await wait(POLL_DELAY_MS); if (shouldStop()) break; }
    const previous = current;
    const next = await requestPortfolio({ action: parentBusy ? 'load' : 'advance', id: previous.job.id });
    if (next.job.requestedCount !== previous.job.requestedCount) throw new Error('Saved portfolio size changed. Reload its progress.');
    onUpdate(next);
    current = next;
    if (approvedPreview && (next.error || next.job.previewAcceptanceError)) throw new Error(next.error || next.job.previewAcceptanceError);
    if (next.preflightReady && !next.error) return current;
    if (next.retryAfterMs !== undefined) {
      if (shouldStop()) break;
      await wait(next.retryAfterMs);
      if (shouldStop()) break;
      continue;
    }
    const newFailedSlot = next.job.slots.some((slot, index) => slot.status === 'RETRY_REQUIRED' && previous.job.slots[index].status !== 'RETRY_REQUIRED');
    if (next.error && !(newFailedSlot && next.job.planReady && !next.job.lease && portfolioCanAdvance(next.job, approvedPreview))) throw new Error(next.error);
    if (!polling && !next.job.lease && JSON.stringify(next.job) === JSON.stringify(previous.job) && portfolioCanAdvance(next.job, approvedPreview)) {
      throw new Error('Portfolio progress did not advance. Reload saved progress before resuming.');
    }
    if (shouldStop()) break;
  }
  return current;
}
