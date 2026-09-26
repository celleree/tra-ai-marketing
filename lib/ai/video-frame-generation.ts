import { fetchWithProviderUsage } from '@/lib/ai/provider-telemetry';
import { prepareTaxDocumentReference } from '@/lib/references/tax-documents.server';
import {
  CREATIVE_CATEGORIES,
  CREATIVE_CATEGORY_LABELS,
} from '@/lib/creative-categories';
import { CREATIVE_FORMAT_LABELS, type CreativeFormatId } from '@/lib/creative-formats';
import type { CreativeReferenceAnalysis } from '@/lib/ai/openai';
import type { ImageGenerationResult } from '@/lib/ai/image-generation-result';
import {
  creativeImageHttpError,
  creativeImageMissingOutputError,
  fetchCreativeImage,
  runCreativeImageModelRoute,
} from '@/lib/creatives/image-models';
import { formatCreativeLogoReservation, formatCreativeSafeZoneRules } from '@/lib/creatives/safe-zones';
import type { CreativeLogoGeometry } from '@/lib/creatives/logo-placement';
import type { CreativeImageCopy } from '@/lib/creatives/generated';
import {
  CREATIVE_PLACEMENT_SPECS,
  type CreativePlacement,
} from '@/lib/creatives/placements';
import {
  getVideoFrameIntegrity,
  isStructurallyValidPng,
} from '@/lib/video/frame-cache';
import {
  MAX_PROVIDER_VIDEO_FRAMES,
  MAX_REPRESENTATIVE_VIDEO_FRAMES,
  type ApprovedTraVideoFrame,
} from '@/lib/video/types';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

const getApiKey = () => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured.');
  return key;
};

const getErrorMessage = async (response: Response) => {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    return payload.error?.message || `OpenAI request failed with ${response.status}.`;
  } catch {
    return `OpenAI request failed with ${response.status}.`;
  }
};

const validateApprovedFrames = (frames: ApprovedTraVideoFrame[]) => {
  if (frames.length < 1 || frames.length > MAX_REPRESENTATIVE_VIDEO_FRAMES) {
    throw new Error('Approved TRA video frames must be a bounded non-empty frame set.');
  }
  const first = frames[0];
  for (const [index, frame] of frames.entries()) {
    const integrity = getVideoFrameIntegrity(frame.buffer);
    if (
      frame.frameIndex !== index ||
      frame.sourceRole !== 'TRA_VIDEO' ||
      frame.approvedHumanSource !== true ||
      frame.mimeType !== 'image/png' ||
      !isStructurallyValidPng(frame.buffer) ||
      frame.frameSha256 !== integrity.frameSha256 ||
      frame.byteLength !== integrity.byteLength ||
      frame.sourceVideoMediaId !== first.sourceVideoMediaId ||
      frame.sourceVideoFileName !== first.sourceVideoFileName ||
      frame.sourceVideoContentHash !== first.sourceVideoContentHash ||
      !Number.isInteger(frame.timestampMs) ||
      frame.timestampMs < 0
    ) {
      throw new Error('Refusing non-TRA or invalid pixels at the TRA video-frame provider boundary.');
    }
  }
};

export const selectProviderVideoFrames = (frames: ApprovedTraVideoFrame[]) => {
  validateApprovedFrames(frames);
  if (frames.length <= MAX_PROVIDER_VIDEO_FRAMES) return frames;
  const indexes = [0, Math.floor((frames.length - 1) / 2), frames.length - 1];
  return Array.from(new Set(indexes)).slice(0, MAX_PROVIDER_VIDEO_FRAMES).map((index) => frames[index]);
};

const extractOutputText = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return '';
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return '';
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'output_text' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
    }
  }
  return '';
};

const categoryList = CREATIVE_CATEGORIES.map(
  (category) => `- ${category}: ${CREATIVE_CATEGORY_LABELS[category]}`
).join('\n');

export async function analyzeApprovedTraVideoFrames(args: {
  frames: ApprovedTraVideoFrame[];
  context: string;
}): Promise<CreativeReferenceAnalysis> {
  const providerFrames = selectProviderVideoFrames(args.frames);
  const model = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra';
  const rules = `Analyze still frames extracted by the server from ONE validated Tax Relief Advocates (TRA) video. These are approved TRA-owned source pixels. Use visible human identity and factual/content cues as TRA source context, NOT as a static-ad layout blueprint. Do not infer customer identity, testimonial status, outcomes, performance, or unsupported claims. Old captions, logos, and framing are context only. Preserve the visible approved person when useful; avoid stale copy/layout and unsupported implications. Classify into exactly one category:\n${categoryList}`;
  const content: Array<Record<string, unknown>> = [
    { type: 'input_text', text: `Source video: ${providerFrames[0].sourceVideoMediaId}\nTimestamps: ${providerFrames.map((frame) => `${frame.timestampMs}ms`).join(', ')}\n\nUser/company direction:\n${args.context}` },
    ...providerFrames.map((frame) => ({
      type: 'input_image',
      image_url: `data:image/png;base64,${frame.buffer.toString('base64')}`,
      detail: 'high',
    })),
  ];
  const response = await fetchWithProviderUsage('video-source-analysis', model, `${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 8192,
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: rules }] },
        { role: 'user', content },
      ],
      text: { format: { type: 'json_schema', name: 'tra_video_frame_analysis', strict: true, schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' }, visibleText: { type: 'array', items: { type: 'string' } }, visualStructure: { type: 'string' }, hookOrAngle: { type: 'string' }, offerOrCta: { type: 'string' }, styleNotes: { type: 'string' }, preserve: { type: 'array', items: { type: 'string' } }, avoid: { type: 'array', items: { type: 'string' } }, unknowns: { type: 'array', items: { type: 'string' } }, dominantCategory: { type: 'string', enum: [...CREATIVE_CATEGORIES] },
        },
        required: ['summary','visibleText','visualStructure','hookOrAngle','offerOrCta','styleNotes','preserve','avoid','unknowns','dominantCategory'],
        additionalProperties: false,
      } } },
    }),
  });
  if (!response.ok) throw new Error(await getErrorMessage(response));
  const payload = await response.json() as { status?: string } | null;
  if (payload?.status !== 'completed') {
    throw new Error('TRA video-frame analysis did not complete.');
  }
  const text = extractOutputText(payload);
  if (!text) throw new Error('OpenAI returned no TRA video-frame analysis.');
  return JSON.parse(text) as CreativeReferenceAnalysis;
}

export interface VideoImageGenerationResult extends ImageGenerationResult {
  providerFrames: ApprovedTraVideoFrame[];
}

const formatImageCopy = (copy: CreativeImageCopy) => [
  `Headline: ${copy.headline}`,
  copy.shortSupport ? `Short support: ${copy.shortSupport}` : '',
  copy.proofAttribution ? `Proof attribution: ${copy.proofAttribution}` : '',
  copy.cta ? `CTA: ${copy.cta}` : '',
  copy.disclosure ? `Disclosure: ${copy.disclosure}` : '',
].filter(Boolean).join('\n');

export async function generateApprovedTraVideoFrameCreativeImage(args: {
  taxDocumentReference?: import('@/lib/references/tax-documents').TaxDocumentSelection;
  frames: ApprovedTraVideoFrame[];
  primaryFormat: CreativeFormatId;
  placement?: CreativePlacement;
  context: string;
  copy: CreativeImageCopy;
  logoGeometry?: CreativeLogoGeometry;
}): Promise<VideoImageGenerationResult> {
  const frames = selectProviderVideoFrames(args.frames);
  const document = await prepareTaxDocumentReference(args.taxDocumentReference);
  const placement = CREATIVE_PLACEMENT_SPECS[args.placement ?? 'SQUARE_1_1'];
  const prompt = `Create an ORIGINAL ${placement.aspectRatio} static Facebook/Instagram ad for Tax Relief Advocates (TRA). Compose natively for the ${placement.aspectRatio} canvas (${placement.width}x${placement.height}); recompose the hierarchy, person, image copy, CTA, and logo space for this ratio rather than cropping or stretching a square design. The attachments named approved-tra-video-* are server-extracted still frames from one validated TRA-owned video. Raw video is NOT attached. No layout-reference pixels or third-party people are attached. ${document?.prompt ?? ''} Source TRA video media ID: ${frames[0].sourceVideoMediaId}. Timestamps: ${frames.map((frame) => `${frame.timestampMs}ms`).join(', ')}. Primary format: ${CREATIVE_FORMAT_LABELS[args.primaryFormat]}. One-ad render brief: ${args.context}. Use only this planned image copy when rendering text inside the creative: ${formatImageCopy(args.copy)}. The frames are the only approved human-identity source. Depict a person only when visibly grounded in them; preserve identity and never invent, replace, blend, or add another person. Do not recreate old captions, logos, badges, or video layout. ${args.logoGeometry ? formatCreativeLogoReservation(args.logoGeometry) : ''} Do not invent testimonials, statistics, dollar amounts, outcomes, endorsements, government affiliation, competitor claims, or guarantees. Keep the ad credible and readable. ${formatCreativeSafeZoneRules(args.placement ?? 'SQUARE_1_1')}`;
  const routed = await runCreativeImageModelRoute({
    operationType: 'TRA_VIDEO_FRAME_GENERATION',
    generate: async (model) => {
      const formData = new FormData();
      formData.set('model', model);
      formData.set('prompt', prompt);
      formData.set('size', placement.providerSize);
      formData.set('quality', 'high');
      formData.set('output_format', 'png');
      for (const frame of frames) {
        formData.append('image[]', new Blob([new Uint8Array(frame.buffer)], { type: 'image/png' }), `approved-tra-video-${frame.sourceVideoMediaId}-${frame.timestampMs}ms.png`);
      }
      document?.appendTo(formData);
      const response = await fetchCreativeImage(`${OPENAI_BASE_URL}/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getApiKey()}` },
        body: formData,
      });
      if (!response.ok) {
        throw creativeImageHttpError(response.status, await getErrorMessage(response));
      }
      const payload = (await response.json()) as { data?: Array<{ b64_json?: string }> };
      const base64 = payload.data?.[0]?.b64_json;
      if (!base64) throw creativeImageMissingOutputError();
      return Buffer.from(base64, 'base64');
    },
  });
  return { buffer: routed.value, prompt, model: routed.routing.actualModel, routing: routed.routing, providerFrames: frames };
}
