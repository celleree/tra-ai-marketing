import { CREATIVE_FORMAT_LABELS, type CreativeFormatId } from '@/lib/creative-formats';
import type { ImageGenerationResult } from '@/lib/ai/image-generation-result';
import type { CreativeCopy } from '@/lib/creatives/generated';
import {
  creativeImageHttpError,
  creativeImageMissingOutputError,
  fetchCreativeImage,
  runCreativeImageModelRoute,
  type CreativeImageOperationType,
} from '@/lib/creatives/image-models';
import {
  CREATIVE_PLACEMENT_SPECS,
  type CreativePlacement,
} from '@/lib/creatives/placements';
import { formatCreativeLogoReservation, formatCreativeSafeZoneRules } from '@/lib/creatives/safe-zones';
import type { CreativeLogoGeometry } from '@/lib/creatives/logo-placement';
import type { StoredMediaFile } from '@/lib/media/types';
import type { TaxDocumentSelection } from '@/lib/references/tax-documents';
import { prepareTaxDocumentReference } from '@/lib/references/tax-documents.server';
import { selectProviderVideoFrames, type VideoImageGenerationResult } from '@/lib/ai/video-frame-generation';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';
import { prepareProviderVideoFrames } from '@/lib/video/source-overlay';

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

const runImageEdit = async (args: {
  operationType: Extract<CreativeImageOperationType, 'TRA_REFERENCE_GENERATION' | 'TRA_VIDEO_FRAME_GENERATION'>;
  prompt: string;
  providerSize: string;
  images: Array<{ buffer: Buffer; mimeType: string; fileName: string }>;
  document: Awaited<ReturnType<typeof prepareTaxDocumentReference>>;
}): Promise<ImageGenerationResult> => {
  const routed = await runCreativeImageModelRoute({
    operationType: args.operationType,
    generate: async (model) => {
      const formData = new FormData();
      formData.set('model', model);
      formData.set('prompt', args.prompt);
      formData.set('size', args.providerSize);
      formData.set('quality', 'high');
      formData.set('output_format', 'png');
      for (const image of args.images) {
        formData.append(
          'image[]',
          new Blob([new Uint8Array(image.buffer)], { type: image.mimeType }),
          image.fileName,
        );
      }
      args.document?.appendTo(formData);
      const response = await fetchCreativeImage(`${OPENAI_BASE_URL}/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getApiKey()}` },
        body: formData,
      });
      if (!response.ok) throw creativeImageHttpError(response.status, await getErrorMessage(response));
      const payload = (await response.json()) as { data?: Array<{ b64_json?: string }> };
      const base64 = payload.data?.[0]?.b64_json;
      if (!base64) throw creativeImageMissingOutputError();
      return Buffer.from(base64, 'base64');
    },
  });
  return { buffer: routed.value, prompt: args.prompt, model: routed.routing.actualModel, routing: routed.routing };
};

export const generateLegacyPromptOnlyCreativeImage = async (args: {
  taxDocumentReference?: TaxDocumentSelection;
  primaryFormat: keyof typeof CREATIVE_FORMAT_LABELS;
  placement: CreativePlacement;
  context: string;
  copy: CreativeCopy;
  logoGeometry?: CreativeLogoGeometry;
  operationType?: Extract<CreativeImageOperationType, 'PROMPT_GENERATION' | 'LAYOUT_REFERENCE_GENERATION'>;
}): Promise<ImageGenerationResult> => {
  const placement = CREATIVE_PLACEMENT_SPECS[args.placement];
  const document = await prepareTaxDocumentReference(args.taxDocumentReference);
  const logoDirection = args.logoGeometry ? formatCreativeLogoReservation(args.logoGeometry) : '';
  const prompt = `
Create an ORIGINAL ${placement.aspectRatio} static Facebook/Instagram ad for Tax Relief Advocates (TRA).

Compose natively for the ${placement.aspectRatio} canvas (${placement.width}x${placement.height}). Recompose the hierarchy, subject, copy, CTA, and logo space for this ratio; do not crop or stretch a square design.

Primary creative format: ${CREATIVE_FORMAT_LABELS[args.primaryFormat]}
One-ad render brief: ${args.context}

Use this planned ad copy verbatim when rendered:
Headline: ${args.copy.headline}
Primary text: ${args.copy.primaryText}
Description: ${args.copy.description}

${logoDirection}
${formatCreativeSafeZoneRules(args.placement)}
TRA guardrails:
- ${document ? 'Use the document exemplar only for the planned paperwork.' : 'This request has no attached reference image.'} Follow the selected blueprint in the one-ad brief when present; otherwise create the planned original layout.
- Do not depict a person, face, spokesperson, or human figure. No approved TRA human identity is attached to this image-generation call, so use a non-human concept.
- Do not invent a testimonial, review quote, statistic, dollar amount, customer outcome, expert endorsement, government affiliation, competitor claim, or guarantee.
- If the assigned format normally relies on evidence that is not supplied, preserve the format concept without inventing the evidence.
- Do not imply universal tax-debt results.
- Keep the design credible, consumer-friendly, and readable on a phone.
- Use strong visual hierarchy and avoid tiny text or clutter.
- The only company or brand name that may appear is Tax Relief Advocates or TRA.
${document?.prompt ?? ''}
`;
  const routed = await runCreativeImageModelRoute({
    operationType: args.operationType ?? 'PROMPT_GENERATION',
    generate: async (model) => {
      const parameters = { model, prompt, size: placement.providerSize, quality: 'high', output_format: 'png' };
      const form = new FormData();
      if (document) {
        for (const [key, value] of Object.entries(parameters)) form.set(key, value);
        document.appendTo(form);
      }
      const response = await fetchCreativeImage(`${OPENAI_BASE_URL}/images/${document ? 'edits' : 'generations'}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getApiKey()}`,
          ...(document ? {} : { 'Content-Type': 'application/json' }),
        },
        body: document ? form : JSON.stringify(parameters),
      });
      if (!response.ok) throw creativeImageHttpError(response.status, await getErrorMessage(response));
      const payload = (await response.json()) as { data?: Array<{ b64_json?: string }> };
      const base64 = payload.data?.[0]?.b64_json;
      if (!base64) throw creativeImageMissingOutputError();
      return Buffer.from(base64, 'base64');
    },
  });
  return { buffer: routed.value, prompt, model: routed.routing.actualModel, routing: routed.routing };
};

export async function generateLegacyApprovedTraReferenceCreativeImage(args: {
  taxDocumentReference?: TaxDocumentSelection;
  source: StoredMediaFile;
  primaryFormat: CreativeFormatId;
  secondaryFormat?: CreativeFormatId;
  placement?: CreativePlacement;
  context: string;
  copy: CreativeCopy;
  logoGeometry?: CreativeLogoGeometry;
}): Promise<ImageGenerationResult> {
  const placement = args.placement ?? 'SQUARE_1_1';
  const placementSpec = CREATIVE_PLACEMENT_SPECS[placement];
  const document = await prepareTaxDocumentReference(args.taxDocumentReference);
  const prompt = `
Create an ORIGINAL ${placementSpec.aspectRatio} static Facebook/Instagram ad for Tax Relief Advocates (TRA).

Compose natively for the ${placementSpec.aspectRatio} canvas (${placementSpec.width}x${placementSpec.height}). Recompose the hierarchy, subject, copy, CTA, and logo space for this ratio; do not crop or stretch a square design.

The first attached image is a validated, TRA-owned reference. Layout references and video frames are not attached.
${document?.prompt ?? ''}

Primary creative format: ${CREATIVE_FORMAT_LABELS[args.primaryFormat]}
${args.secondaryFormat ? `Secondary creative format: ${CREATIVE_FORMAT_LABELS[args.secondaryFormat]}` : ''}
One-ad render brief: ${args.context}

Use this planned ad copy verbatim when rendered:
Headline: ${args.copy.headline}
Primary text: ${args.copy.primaryText}
Description: ${args.copy.description}

Approved-source rules:
- The first attached TRA image is the only approved human-identity source for this generation call.
- If the output depicts a person, preserve the visible identity from the attached TRA image. Do not invent, replace, blend, or add another person.
- Do not recreate the attached image verbatim or depend on its old layout unless the text direction explicitly asks for a high-level structural cue.
- Make the result clearly original and specific to TRA.
${formatCreativeSafeZoneRules(placement)}
${args.logoGeometry ? formatCreativeLogoReservation(args.logoGeometry) : ''}
TRA guardrails:
- Do not invent a testimonial, review quote, statistic, dollar amount, customer outcome, expert endorsement, government affiliation, competitor claim, or guarantee.
- If the assigned format normally relies on evidence that is not supplied, preserve the format concept without inventing the evidence.
- Do not imply universal tax-debt results.
- Keep the design credible, consumer-friendly, and readable on a phone.
- Strong visual hierarchy. Avoid tiny text and clutter.
- The only company/brand name that may appear is Tax Relief Advocates or TRA.
`;
  return runImageEdit({
    operationType: 'TRA_REFERENCE_GENERATION',
    prompt,
    providerSize: placementSpec.providerSize,
    images: [{ buffer: args.source.buffer, mimeType: args.source.mimeType, fileName: `approved-tra-source-${args.source.fileName}` }],
    document,
  });
}

export async function generateLegacyApprovedTraVideoFrameCreativeImage(args: {
  taxDocumentReference?: TaxDocumentSelection;
  frames: ApprovedTraVideoFrame[];
  primaryFormat: CreativeFormatId;
  placement?: CreativePlacement;
  context: string;
  copy: CreativeCopy;
  logoGeometry?: CreativeLogoGeometry;
}): Promise<VideoImageGenerationResult> {
  const frames = await prepareProviderVideoFrames(selectProviderVideoFrames(args.frames));
  const placementId = args.placement ?? 'SQUARE_1_1';
  const placement = CREATIVE_PLACEMENT_SPECS[placementId];
  const document = await prepareTaxDocumentReference(args.taxDocumentReference);
  const prompt = `Create an ORIGINAL ${placement.aspectRatio} static Facebook/Instagram ad for Tax Relief Advocates (TRA). Compose natively for the ${placement.aspectRatio} canvas (${placement.width}x${placement.height}); recompose the hierarchy, person, copy, CTA, and logo space for this ratio rather than cropping or stretching a square design. The attachments named approved-tra-video-* are server-extracted still frames or pixel-only edge crops from one validated TRA-owned video. Raw video is NOT attached. No layout-reference pixels or third-party people are attached. ${document?.prompt ?? ''} Source TRA video media ID: ${frames[0].sourceVideoMediaId}. Timestamps: ${frames.map((frame) => `${frame.timestampMs}ms`).join(', ')}. Primary format: ${CREATIVE_FORMAT_LABELS[args.primaryFormat]}. One-ad render brief: ${args.context}. Headline: ${args.copy.headline}. Primary text: ${args.copy.primaryText}. Description: ${args.copy.description}. The frames are the only approved human-identity source. Depict a person only when visibly grounded in them; preserve identity and never invent, replace, blend, or add another person. Do not recreate old captions, logos, badges, or video layout. ${args.logoGeometry ? formatCreativeLogoReservation(args.logoGeometry) : ''} Do not invent testimonials, statistics, dollar amounts, outcomes, endorsements, government affiliation, competitor claims, or guarantees. Keep the ad credible and readable. ${formatCreativeSafeZoneRules(placementId)}`;
  const result = await runImageEdit({
    operationType: 'TRA_VIDEO_FRAME_GENERATION',
    prompt,
    providerSize: placement.providerSize,
    images: frames.map((frame) => ({
      buffer: frame.providerBuffer,
      mimeType: 'image/png',
      fileName: `approved-tra-video-${frame.sourceVideoMediaId}-${frame.timestampMs}ms.png`,
    })),
    document,
  });
  return { ...result, providerFrames: frames };
}
