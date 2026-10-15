import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { CreativePortfolioJob } from '@/lib/creatives/portfolio-job';
import type { ProviderAttemptMetadata } from '@/lib/ai/provider-usage';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

import { PREVIEW_TEST_APPROVAL } from '@/lib/creatives/preview-test-binding';
export { PREVIEW_TEST_APPROVAL } from '@/lib/creatives/preview-test-binding';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
export const previewTestRequestHash = (request: CreativePortfolioJob['request']) => sha(JSON.stringify(canonical(request)));
const active = () => process.env.VERCEL_ENV === 'preview' && process.env.TRA_IMAGE_PURPOSE === 'staging-smoke';
export const isApprovedPreviewPortfolio = (job: CreativePortfolioJob | null) => Boolean(active() && job
  && job.id === PREVIEW_TEST_APPROVAL.portfolioId && previewTestRequestHash(job.request) === PREVIEW_TEST_APPROVAL.requestSha256
  && job.slots.length === 2 && job.slots.every((slot, index) => slot.creativeId === PREVIEW_TEST_APPROVAL.creativeIds[index]));
const scopes = new AsyncLocalStorage<{ portfolioId: string; storage?: VideoIntelligenceStorage } | undefined>();
export const withApprovedPreviewPortfolio = <T>(job: CreativePortfolioJob | null, storage: VideoIntelligenceStorage | undefined,
  work: () => Promise<T>) => scopes.run(isApprovedPreviewPortfolio(job) ? { portfolioId: job!.id, storage } : undefined, work);
export const approvedPreviewProviderContext = (meta: ProviderAttemptMetadata) => {
  const scope = scopes.getStore();
  return Boolean(active() && scope && scope.portfolioId === meta.portfolioId);
};

/** Reserve a named operation before fetch; never release or reclaim it, even after uncertainty. */
export async function reserveApprovedPreviewResponse(meta: ProviderAttemptMetadata, init: RequestInit): Promise<RequestInit> {
  const scope = scopes.getStore();
  if (!active() || !scope) return init; // The independent provider guard rejects unscoped Preview calls.
  const deny = () => { throw new Error('Approved Preview request changed or is outside its fixed call scope. No provider call was made.'); };
  if (init.method !== 'POST' || typeof init.body !== 'string' || Buffer.byteLength(init.body) > 16 * 1024 * 1024) return deny();
  const body = JSON.parse(init.body);
  if (body.model !== meta.model || body.store !== false || !Array.isArray(body.input) || body.input.length !== 2
    || body.input[0]?.role !== 'developer' || body.input[1]?.role !== 'user'
    || Object.keys(body).some(key => !['model', 'store', 'input', 'text', 'reasoning', 'max_output_tokens'].includes(key))) return deny();
  const parts = body.input.flatMap((message: { content?: unknown }) => Array.isArray(message.content) ? message.content : []);
  if (parts.some((part: { type?: string }) => !['input_text', 'input_image'].includes(part.type ?? ''))) return deny();
  const images = parts.filter((part: { type?: string }) => part.type === 'input_image');
  const inputHashes = images.map((image: { image_url?: unknown }) => {
    if (typeof image.image_url !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(image.image_url)) return deny();
    const bytes = Buffer.from(image.image_url.slice(image.image_url.indexOf(',') + 1), 'base64');
    if (bytes.length > 10 * 1024 * 1024) return deny();
    return sha(bytes);
  });
  const textBytes = Buffer.byteLength(JSON.stringify({ ...body, input: body.input.map((message: Record<string, unknown>) => ({
    ...message, content: (message.content as Record<string, unknown>[]).map(part => part.type === 'input_image'
      ? { ...part, image_url: '[validated image]' } : part),
  })) }));
  if (textBytes > 256 * 1024) return deny();
  let step: string, limit: number;
  if (meta.stage === 'creative-plan' || meta.stage === 'portfolio-audit') {
    if (images.length || meta.model !== 'gpt-6.1-sol') return deny();
    step = meta.stage; limit = step === 'creative-plan' ? 7168 : 4608;
  } else {
    if (meta.model !== 'gpt-6-luna' || inputHashes.length !== 1) return deny();
    const name = body.text?.format?.name;
    if (meta.stage === 'video-human-selection' && name === 'tra_candidate_human_suitability') {
      const index = PREVIEW_TEST_APPROVAL.frameSha256s.indexOf(inputHashes[0]);
      if (index < 0) return deny();
      const binding = JSON.parse(body.input[1]?.content?.[0]?.text);
      if (binding.policy !== 'human-frame-candidate-suitability-v3' || binding.frameSha256 !== inputHashes[0]
        || binding.assessmentContract !== PREVIEW_TEST_APPROVAL.assessmentContract
        || binding.candidateIndex !== PREVIEW_TEST_APPROVAL.frameCandidateIndexes[index]) return deny();
      step = 'frame-' + index; limit = 2048;
    } else return deny();
  }
  if (body.max_output_tokens !== undefined && (!Number.isInteger(body.max_output_tokens)
    || body.max_output_tokens < 1 || body.max_output_tokens > limit)) return deny();
  const normalized = { ...body, max_output_tokens: body.max_output_tokens ?? limit, service_tier: 'default' };
  const storage = scope.storage ?? getVideoIntelligenceStorage();
  const key = 'preview-test-calls/v1/' + PREVIEW_TEST_APPROVAL.id + '/' + step + '.json';
  if (!await storage.write(key, Buffer.from(JSON.stringify({ version: 1, portfolioId: scope.portfolioId,
    requestSha256: PREVIEW_TEST_APPROVAL.requestSha256, fingerprint: sha(JSON.stringify(normalized)) })), null)) {
    throw new Error('This approved Preview call was already reserved. No repeat purchase is authorized.');
  }
  return { ...init, body: JSON.stringify(normalized) };
}
