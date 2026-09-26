import type { ImageGenerationResult } from '@/lib/ai/image-generation-result';
import { buildCreativeRenderBrief, formatCreativeRenderBrief } from '@/lib/creatives/render-brief';
import type { RuntimeCompanyProfileSnapshot } from '@/lib/company/creative-context';
import type { ReferencePlanningCandidate } from '@/lib/references/planning';
import { prepareTaxDocumentReference } from '@/lib/references/tax-documents.server';
import type { hydrateSavedCreativeRevisionContext } from '@/lib/creatives/revision-source-hydration';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import type { CreativeIdentity } from '@/lib/creatives/identity';
import { classifyCreativeCopyContract } from '@/lib/creatives/copy-contract';
import { CREATIVE_PLACEMENT_SPECS, type CreativePlacement } from '@/lib/creatives/placements';
import type { CreativeProofProvenance } from '@/lib/proof/provenance';
import { parseCreativeStrategy } from '@/lib/creatives/strategy';
import { formatCreativeLogoReservation, formatCreativeSafeZoneRules } from '@/lib/creatives/safe-zones';
import type { CreativeLogoGeometry } from '@/lib/creatives/logo-placement';
import { prepareProviderVideoFrames } from '@/lib/video/source-overlay';
import {
  creativeImageHttpError,
  creativeImageMissingOutputError,
  fetchCreativeImage,
  runCreativeImageModelRoute,
} from '@/lib/creatives/image-models';

type RevisionSources = Pick<Awaited<ReturnType<typeof hydrateSavedCreativeRevisionContext>>,
  'canvas' | 'originalApprovedSource' | 'logoOverlay'>;
type RevisionOperation = Exclude<CreativeIdentity['operation'], 'GENERATE'>;
const DIRECTIONS: Record<RevisionOperation, string> = {
  EDIT: 'Apply the requested edit. Preserve the selected canvas and all unrequested details where practical, subject to the current approved strategy and compliance rules.',
  PLACEMENT: 'Preserve the concept and message. Recompose hierarchy, imagery, text and CTA natively for the target ratio; do not crop or stretch the old canvas.',
  REGENERATE: 'Create a fresh rendition of the same hypothesis, strategy and copy. Use the selected canvas as concept context, not a pixel-exact template.',
  VARIATION: 'Create a meaningfully different execution of the supplied revised strategy. Follow its changed strategic and execution dimensions, not superficial recolors or headline swaps.',
};

export async function generateCreativeRevisionImage(args: {
  sources: RevisionSources;
  operation: RevisionOperation;
  concept: Pick<PlannedCreativeConcept, 'format' | 'copy' | 'adCopy' | 'imageCopy' | 'strategy'>;
  placement: CreativePlacement;
  companyProfile?: RuntimeCompanyProfileSnapshot;
  referenceCatalog?: ReferencePlanningCandidate[];
  proofProvenance?: CreativeProofProvenance;
  logoGeometry?: CreativeLogoGeometry;
}): Promise<ImageGenerationResult> {
  const { canvas, originalApprovedSource } = args.sources;
  if (args.concept.strategy.execution.subjectSource === 'non-human' && originalApprovedSource?.kind === 'TRA_VIDEO_FRAMES') {
    throw new Error('Non-human revision cannot attach TRA video-human frames.');
  }
  if (classifyCreativeCopyContract(args.concept as unknown as Record<string, unknown>).kind === 'INVALID') {
    throw new Error('Revision concept has an invalid separated ad/image copy contract.');
  }
  if (!parseCreativeStrategy(args.concept.strategy, originalApprovedSource !== null)) {
    throw new Error('Revision strategy is invalid or requires an unavailable approved TRA source.');
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const providerVideoFrames = originalApprovedSource?.kind === 'TRA_VIDEO_FRAMES'
    ? await prepareProviderVideoFrames(originalApprovedSource.frames) : null;
  const spec = CREATIVE_PLACEMENT_SPECS[args.placement];
  const document = await prepareTaxDocumentReference(args.concept.strategy.execution.taxDocumentReference);
  const prompt = `Create an original static Tax Relief Advocates (TRA) ad at ${spec.width}x${spec.height}, aspect ratio ${spec.aspectRatio}.
Operation: ${args.operation}. ${DIRECTIONS[args.operation]}
${formatCreativeSafeZoneRules(args.placement)}
The FIRST attached image is the selected saved EDITING_CANVAS. It is generated editing context, never an approved human-identity source or evidence for factual claims.
${args.logoGeometry ? 'Its transparent rectangle is the deterministically removed prior logo panel. Reconstruct the surrounding background naturally through that cutout; do not retain or redraw the old logo or panel.' : ''}
${originalApprovedSource
    ? 'The attachments named approved-tra-* are the separately validated original approved TRA reference or approved TRA video PNG frames or pixel-only edge crops. Only these attachments may supply human identity; preserve that identity without adding, blending or replacing people.'
    : 'There are no approved human source attachments. Do not depict any person, including a person visible in the editing canvas.'}
${args.concept.strategy.execution.subjectSource === 'non-human' ? 'The planned concept is non-human. Do not depict people even if original approved sources contain people.' : ''}
No ad-layout reference, video-analysis JPEGs or logo artwork are attached as generation sources.
${document?.prompt ?? ''}
${formatCreativeRenderBrief(buildCreativeRenderBrief({ concept: args.concept, companyProfile: args.companyProfile, referenceCatalog: args.referenceCatalog, ...(args.proofProvenance ? { proofProvenance: args.proofProvenance } : {}) }))}
Saved canvas copy and prior outputs do not approve factual claims. Execute the planned copy and visual direction while respecting the brief's prohibited claims and required disclaimers.
Never invent testimonials, quotes, statistics, dollar amounts, outcomes, guarantees, endorsements, government affiliation or competitor claims. Do not imply universal tax-debt results. The only company name is Tax Relief Advocates or TRA.
Keep text readable on a phone, with clear hierarchy and no clutter.
${args.logoGeometry ? formatCreativeLogoReservation(args.logoGeometry) : ''}`;
  const append = (form: FormData, buffer: Buffer, mimeType: string, name: string) =>
    form.append('image[]', new Blob([new Uint8Array(buffer)], { type: mimeType }), name);
  const routed = await runCreativeImageModelRoute({
    operationType: args.operation,
    generate: async (model) => {
      const form = new FormData();
      for (const [key, value] of Object.entries({ model, prompt, size: spec.providerSize, quality: 'high', output_format: 'png' })) {
        form.set(key, value);
      }
      append(form, canvas.buffer, canvas.mimeType, `editing-canvas-${canvas.fileName}`);
      if (originalApprovedSource?.kind === 'TRA_REFERENCE') {
        const source = originalApprovedSource.source.stored;
        append(form, source.buffer, source.mimeType, `approved-tra-source-${source.fileName}`);
      } else if (providerVideoFrames) {
        providerVideoFrames.forEach((frame, index) =>
          append(form, frame.providerBuffer, frame.mimeType, `approved-tra-frame-${index + 1}.png`));
      }
      document?.appendTo(form);
      const response = await fetchCreativeImage('https://api.openai.com/v1/images/edits', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
      });
      if (!response.ok) {
        throw creativeImageHttpError(response.status, `OpenAI image revision failed with ${response.status}.`);
      }
      const payload = await response.json() as { data?: Array<{ b64_json?: string }> };
      const base64 = payload.data?.[0]?.b64_json;
      if (typeof base64 !== 'string' || !base64) throw creativeImageMissingOutputError();
      return Buffer.from(base64, 'base64');
    },
  });
  return { buffer: routed.value, prompt, model: routed.routing.actualModel, routing: routed.routing };
}
