import { prepareTaxDocumentReference } from '@/lib/references/tax-documents.server';
import type { TaxDocumentSelection } from '@/lib/references/tax-documents';
import { formatCreativeLogoReservation, formatCreativeSafeZoneRules } from '@/lib/creatives/safe-zones';
import type { ImageGenerationResult } from '@/lib/ai/image-generation-result';
import { CREATIVE_FORMAT_LABELS } from '@/lib/creative-formats';
import type { CreativeImageCopy } from '@/lib/creatives/generated';
import type { CreativeLogoGeometry } from '@/lib/creatives/logo-placement';
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

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

const getOpenAIError = async (response: Response) => {
  try {
    const payload = (await response.json()) as {
      error?: { message?: string };
    };
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

export const generatePromptOnlyCreativeImage = async (args: {
  taxDocumentReference?: TaxDocumentSelection;
  primaryFormat: keyof typeof CREATIVE_FORMAT_LABELS;
  placement: CreativePlacement;
  context: string;
  copy: CreativeImageCopy;
  logoGeometry?: CreativeLogoGeometry;
  operationType?: Extract<CreativeImageOperationType, 'PROMPT_GENERATION' | 'LAYOUT_REFERENCE_GENERATION'>;
}): Promise<ImageGenerationResult> => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const placement = CREATIVE_PLACEMENT_SPECS[args.placement];
  const document = await prepareTaxDocumentReference(args.taxDocumentReference);
  const logoDirection = args.logoGeometry ? formatCreativeLogoReservation(args.logoGeometry) : '';
  const prompt = `
Create an ORIGINAL ${placement.aspectRatio} static Facebook/Instagram ad for Tax Relief Advocates (TRA).

Compose natively for the ${placement.aspectRatio} canvas (${placement.width}x${placement.height}). Recompose the hierarchy, subject, image copy, CTA, and logo space for this ratio; do not crop or stretch a square design.

Primary creative format: ${CREATIVE_FORMAT_LABELS[args.primaryFormat]}
One-ad render brief: ${args.context}

Use only this planned image copy when rendering text inside the creative:
${formatImageCopy(args.copy)}

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
          Authorization: `Bearer ${apiKey}`,
          ...(document ? {} : { 'Content-Type': 'application/json' }),
        },
        body: document ? form : JSON.stringify(parameters),
      });
      if (!response.ok) {
        throw creativeImageHttpError(response.status, await getOpenAIError(response));
      }
      const payload = (await response.json()) as {
        data?: Array<{ b64_json?: string }>;
      };
      const base64 = payload.data?.[0]?.b64_json;
      if (!base64) throw creativeImageMissingOutputError();
      return Buffer.from(base64, 'base64');
    },
  });
  return { buffer: routed.value, prompt, model: routed.routing.actualModel, routing: routed.routing };
};
