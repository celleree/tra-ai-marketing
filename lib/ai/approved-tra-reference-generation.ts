import type { CreativeFormatId } from '@/lib/creative-formats';
import { CREATIVE_FORMAT_LABELS } from '@/lib/creative-formats';
import type { CreativeImageCopy } from '@/lib/creatives/generated';
import type { ImageGenerationResult } from '@/lib/ai/image-generation-result';
import {
  creativeImageHttpError,
  creativeImageMissingOutputError,
  fetchCreativeImage,
  runCreativeImageModelRoute,
} from '@/lib/creatives/image-models';
import {
  CREATIVE_PLACEMENT_SPECS,
  type CreativePlacement,
} from '@/lib/creatives/placements';
import { formatCreativeLogoReservation, formatCreativeSafeZoneRules } from '@/lib/creatives/safe-zones';
import type { StoredMediaFile } from '@/lib/media/types';
import { prepareTaxDocumentReference } from '@/lib/references/tax-documents.server';
import type { TaxDocumentSelection } from '@/lib/references/tax-documents';

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

const formatImageCopy = (copy: CreativeImageCopy) => [
  `Headline: ${copy.headline}`,
  copy.shortSupport ? `Short support: ${copy.shortSupport}` : '',
  copy.proofAttribution ? `Proof attribution: ${copy.proofAttribution}` : '',
  copy.cta ? `CTA: ${copy.cta}` : '',
  copy.disclosure ? `Disclosure: ${copy.disclosure}` : '',
].filter(Boolean).join('\n');

const appendImage = (formData: FormData, source: StoredMediaFile, fileName: string) => {
  formData.append(
    'image[]',
    new Blob([new Uint8Array(source.buffer)], { type: source.mimeType }),
    fileName
  );
};

export async function generateApprovedTraReferenceCreativeImage(args: {
  taxDocumentReference?: TaxDocumentSelection;
  source: StoredMediaFile;
  primaryFormat: CreativeFormatId;
  secondaryFormat?: CreativeFormatId;
  placement?: CreativePlacement;
  context: string;
  copy: CreativeImageCopy;
  reserveLogoArea?: boolean;
}): Promise<ImageGenerationResult> {
  const placement = args.placement ?? 'SQUARE_1_1';
  const placementSpec = CREATIVE_PLACEMENT_SPECS[placement];
  const document = await prepareTaxDocumentReference(args.taxDocumentReference);
  const prompt = `
Create an ORIGINAL ${placementSpec.aspectRatio} static Facebook/Instagram ad for Tax Relief Advocates (TRA).

Compose natively for the ${placementSpec.aspectRatio} canvas (${placementSpec.width}x${placementSpec.height}). Recompose the hierarchy, subject, image copy, CTA, and logo space for this ratio; do not crop or stretch a square design.

The first attached image is a validated, TRA-owned reference. Layout references and video frames are not attached.
${document?.prompt ?? ''}

Primary creative format: ${CREATIVE_FORMAT_LABELS[args.primaryFormat]}
${args.secondaryFormat ? `Secondary creative format: ${CREATIVE_FORMAT_LABELS[args.secondaryFormat]}` : ''}
One-ad render brief: ${args.context}

Use only this planned image copy when rendering text inside the creative:
${formatImageCopy(args.copy)}

Approved-source rules:
- The first attached TRA image is the only approved human-identity source for this generation call.
- If the output depicts a person, preserve the visible identity from the attached TRA image. Do not invent, replace, blend, or add another person.
- Do not recreate the attached image verbatim or depend on its old layout unless the text direction explicitly asks for a high-level structural cue.
- Make the result clearly original and specific to TRA.
${formatCreativeSafeZoneRules(placement)}
${args.reserveLogoArea ? formatCreativeLogoReservation(placement) : ''}
TRA guardrails:
- Do not invent a testimonial, review quote, statistic, dollar amount, customer outcome, expert endorsement, government affiliation, competitor claim, or guarantee.
- If the assigned format normally relies on evidence that is not supplied, preserve the format concept without inventing the evidence.
- Do not imply universal tax-debt results.
- Keep the design credible, consumer-friendly, and readable on a phone.
- Strong visual hierarchy. Avoid tiny text and clutter.
- The only company/brand name that may appear is Tax Relief Advocates or TRA.
`;

  const routed = await runCreativeImageModelRoute({
    operationType: 'TRA_REFERENCE_GENERATION',
    generate: async (model) => {
      const formData = new FormData();
      formData.set('model', model);
      formData.set('prompt', prompt);
      formData.set('size', placementSpec.providerSize);
      formData.set('quality', 'high');
      formData.set('output_format', 'png');
      appendImage(formData, args.source, `approved-tra-source-${args.source.fileName}`);
      document?.appendTo(formData);
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

  return { buffer: routed.value, prompt, model: routed.routing.actualModel, routing: routed.routing };
}
