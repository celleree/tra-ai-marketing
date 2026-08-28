import {
  CREATIVE_CATEGORIES,
  CREATIVE_CATEGORY_LABELS,
} from '@/lib/creative-categories';
import { CREATIVE_FORMAT_LABELS, type CreativeFormatId } from '@/lib/creative-formats';
import type { CreativeReferenceAnalysis } from '@/lib/ai/openai';
import type { CreativeCopy } from '@/lib/creatives/generated';
import { detectImageMimeType } from '@/lib/media/storage';
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
    if (
      frame.frameIndex !== index ||
      frame.sourceRole !== 'TRA_VIDEO' ||
      frame.approvedHumanSource !== true ||
      frame.mimeType !== 'image/png' ||
      detectImageMimeType(frame.buffer) !== 'image/png' ||
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
  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      store: false,
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
  const text = extractOutputText(await response.json());
  if (!text) throw new Error('OpenAI returned no TRA video-frame analysis.');
  return JSON.parse(text) as CreativeReferenceAnalysis;
}

export async function generateApprovedTraVideoFrameCreativeImage(args: {
  frames: ApprovedTraVideoFrame[];
  primaryFormat: CreativeFormatId;
  context: string;
  copy: CreativeCopy;
  reserveLogoArea?: boolean;
}): Promise<Buffer> {
  const frames = selectProviderVideoFrames(args.frames);
  const prompt = `Create an ORIGINAL square static Facebook/Instagram ad for Tax Relief Advocates (TRA). The attached images are server-extracted still frames from one validated TRA-owned video. Raw video is NOT attached. No layout-reference pixels, external reference-library pixels, third-party people, or unrelated images are attached. Source TRA video media ID: ${frames[0].sourceVideoMediaId}. Timestamps: ${frames.map((frame) => `${frame.timestampMs}ms`).join(', ')}. Primary format: ${CREATIVE_FORMAT_LABELS[args.primaryFormat]}. User direction: ${args.context}. Headline: ${args.copy.headline}. Primary text: ${args.copy.primaryText}. Description: ${args.copy.description}. The frames are the only approved human-identity source. Depict a person only when visibly grounded in them; preserve identity and never invent, replace, blend, or add another person. Do not recreate old captions, logos, badges, or video layout. ${args.reserveLogoArea ? 'Leave the upper-left logo area clear; do not draw a TRA logo.' : ''} Do not invent testimonials, statistics, dollar amounts, outcomes, endorsements, government affiliation, competitor claims, or guarantees. Keep the ad credible and readable.`;
  const formData = new FormData();
  formData.set('model', process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2');
  formData.set('prompt', prompt);
  formData.set('size', '1024x1024');
  formData.set('quality', 'medium');
  formData.set('output_format', 'png');
  for (const frame of frames) {
    formData.append('image[]', new Blob([new Uint8Array(frame.buffer)], { type: 'image/png' }), `approved-tra-video-${frame.sourceVideoMediaId}-${frame.timestampMs}ms.png`);
  }
  const response = await fetch(`${OPENAI_BASE_URL}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}` },
    body: formData,
  });
  if (!response.ok) throw new Error(await getErrorMessage(response));
  const payload = (await response.json()) as { data?: Array<{ b64_json?: string }> };
  const base64 = payload.data?.[0]?.b64_json;
  if (!base64) throw new Error('OpenAI returned no generated image.');
  return Buffer.from(base64, 'base64');
}
