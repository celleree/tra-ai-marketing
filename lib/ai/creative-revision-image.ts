import type { ImageGenerationResult } from '@/lib/ai/image-generation-result';
import type { hydrateSavedCreativeRevisionContext } from '@/lib/creatives/revision-source-hydration';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import type { CreativeIdentity } from '@/lib/creatives/identity';
import { CREATIVE_PLACEMENT_SPECS, type CreativePlacement } from '@/lib/creatives/placements';
import { parseCreativeStrategy } from '@/lib/creatives/strategy';

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
  concept: Pick<PlannedCreativeConcept, 'format' | 'copy' | 'strategy'>;
  placement: CreativePlacement;
  companyContext: string;
  instruction?: string;
}): Promise<ImageGenerationResult> {
  const { canvas, originalApprovedSource, logoOverlay } = args.sources;
  if (!parseCreativeStrategy(args.concept.strategy, originalApprovedSource !== null)) {
    throw new Error('Revision strategy is invalid or requires an unavailable approved TRA source.');
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const spec = CREATIVE_PLACEMENT_SPECS[args.placement];
  const prompt = `Create an original static Tax Relief Advocates (TRA) ad at ${spec.width}x${spec.height}, aspect ratio ${spec.aspectRatio}.
Operation: ${args.operation}. ${DIRECTIONS[args.operation]}
The FIRST attached image is the selected saved EDITING_CANVAS. It is generated editing context, never an approved human-identity source or evidence for factual claims.
${originalApprovedSource
    ? 'The remaining attachments are the separately validated original approved TRA reference or approved TRA video PNG frames. Only these attachments may supply human identity; preserve that identity without adding, blending or replacing people.'
    : 'There are no approved human source attachments. Do not depict any person, including a person visible in the editing canvas.'}
${args.concept.strategy.execution.subjectSource === 'non-human' ? 'The planned concept is non-human. Do not depict people even if original approved sources contain people.' : ''}
No layout reference, external reference-library pixels, analysis JPEGs or logo artwork are attached as generation sources.
Current approved company context:
${args.companyContext}
Requested creative direction (not factual approval): ${args.instruction || 'Follow the selected operation.'}
Planned format, copy and strategy including SO WHAT:
${JSON.stringify(args.concept)}
Use the supplied copy and strategy for messaging. Saved canvas copy, user direction and prior outputs do not approve factual claims. Only explicitly approved claims/proof in the current company context support facts. Respect its prohibited claims and required disclaimers.
Never invent testimonials, quotes, statistics, dollar amounts, outcomes, guarantees, endorsements, government affiliation or competitor claims. Do not imply universal tax-debt results. The only company name is Tax Relief Advocates or TRA.
Keep text readable on a phone, with clear hierarchy and no clutter.
${logoOverlay ? 'Do not draw, imitate or retain a generated logo. Leave the upper-left 27% width and 13% height clear of essential imagery, text and faces. The original approved logo will be composited there after generation.' : ''}`;
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
  const form = new FormData();
  for (const [key, value] of Object.entries({ model, prompt, size: spec.providerSize, quality: 'high', output_format: 'png' })) {
    form.set(key, value);
  }
  const append = (buffer: Buffer, mimeType: string, name: string) =>
    form.append('image[]', new Blob([new Uint8Array(buffer)], { type: mimeType }), name);
  append(canvas.buffer, canvas.mimeType, `editing-canvas-${canvas.fileName}`);
  if (originalApprovedSource?.kind === 'TRA_REFERENCE') {
    const source = originalApprovedSource.source.stored;
    append(source.buffer, source.mimeType, `approved-tra-source-${source.fileName}`);
  } else if (originalApprovedSource?.kind === 'TRA_VIDEO_FRAMES') {
    originalApprovedSource.frames.forEach((frame, index) =>
      append(frame.buffer, frame.mimeType, `approved-tra-frame-${index + 1}.png`));
  }
  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
  });
  if (!response.ok) throw new Error(`OpenAI image revision failed with ${response.status}.`);
  const payload = await response.json() as { data?: Array<{ b64_json?: string }> };
  const base64 = payload.data?.[0]?.b64_json;
  if (typeof base64 !== 'string' || !base64) throw new Error('OpenAI returned no revised image.');
  return { buffer: Buffer.from(base64, 'base64'), prompt, model };
}
