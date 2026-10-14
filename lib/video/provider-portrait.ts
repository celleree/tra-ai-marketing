import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { CandidateAssessmentIdentity } from '@/lib/video/candidate-suitability';
import type { GenerateVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import type { ProviderPortraitState } from '@/lib/video/provider-portrait-contract';
import type { ProviderVideoFrame } from '@/lib/video/source-overlay';

/** Bind the exact attachment bytes to the frozen source, candidate, crop and current PNG contract. */
export async function providerPortraitInput(selection: GenerateVideoFrameSelection, prepared: ProviderVideoFrame, model: string) {
  const binding = selection.version === 3 && selection.candidateBindings?.length === 1 ? selection.candidateBindings[0] : null;
  if (!binding || prepared.sourceVideoMediaId !== selection.sourceVideoMediaId
    || prepared.sourceVideoContentHash !== selection.sourceVideoContentHash || prepared.timestampMs !== binding.timestampMs
    || createHash('sha256').update(prepared.providerBuffer).digest('hex') !== prepared.providerPngSha256) {
    throw new Error('Provider portrait does not match its confirmed source frame.');
  }
  const metadata = await sharp(prepared.providerBuffer).metadata();
  if (metadata.format !== 'png' || !metadata.width || !metadata.height || metadata.width < 256 || metadata.height < 256) {
    throw new Error('The actual retained portrait PNG has insufficient resolution.');
  }
  const state: ProviderPortraitState = { version: 1, providerPngSha256: prepared.providerPngSha256,
    sourcePngSha256: prepared.frameSha256, crop: prepared.crop, verified: false };
  const identity: CandidateAssessmentIdentity = { policy: 'human-frame-candidate-suitability-v3', model,
    sourceVideoMediaId: selection.sourceVideoMediaId, sourceVideoContentHash: selection.sourceVideoContentHash,
    librarySha256: selection.librarySha256!,
    representativeFrameId: binding.representativeFrameId, candidateIndex: binding.candidateIndex, timestampMs: binding.timestampMs,
    frameSha256: prepared.providerPngSha256, sourcePngSha256: prepared.frameSha256, sourceCrop: prepared.crop,
    assessmentContract: 'clean-provider-portrait-v1' };
  return { state, identity };
}
