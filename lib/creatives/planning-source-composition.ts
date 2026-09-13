import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { analyzeTraSourceCreative } from '@/lib/ai/openai';
import { getLayoutAnalysisModel } from '@/lib/ai/layout-analyzer';
import { analyzeApprovedTraVideoFrames, selectProviderVideoFrames } from '@/lib/ai/video-frame-generation';
import { CreativeGenerationPreparationError, hydratePlanningSourceInventory } from '@/lib/creatives/generation-sources';
import type { ValidGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import type { PlanningSourceAnalysisResult, PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';
import { LAYOUT_BLUEPRINT_SCHEMA_VERSION } from '@/lib/layouts/blueprint';
import { getOrAnalyzeContextualLayoutAngle, getOrAnalyzeLayoutBlueprint } from '@/lib/layouts/service';
import type { MediaStorage } from '@/lib/media/storage';
import type { StoredMediaFile } from '@/lib/media/types';
import type { ReferencePlanningCandidate } from '@/lib/references/planning';
import { getApprovedTraVideoFrames } from '@/lib/video/tra-video-frames';

type SourceRequest = Pick<ValidGenerateCreativeRequest, 'sourceAssets' | 'context'>;
const changed = () => new CreativeGenerationPreparationError('Planning source inventory or analysis identity changed. Start fresh preparation.', 409);

/**
 * Initialize with zero provider operations, then perform at most one per advance.
 * Durable callers checkpoint each state and own leases/explicit retry after uncertain work.
 * The single-request caller retains explicit resubmission and never retries inside this step.
 */
export async function advancePlanningSourceAnalysis(
  request: SourceRequest,
  current: PlanningSourceAnalysisState | undefined,
  onProviderOperationStart: () => void,
  storage?: MediaStorage,
): Promise<{ state: PlanningSourceAnalysisState; complete: boolean }> {
  // Revalidate every supplied source even when its analysis is already complete.
  const inventory = await hydratePlanningSourceInventory(request.sourceAssets, storage);
  const contextSha256 = createHash('sha256').update(request.context).digest('hex');
  const model = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra';
  const entries = [...inventory].sort((a, b) => a.identity.mediaId.localeCompare(b.identity.mediaId)).flatMap(({ identity: source }) => {
    const kinds: PlanningSourceAnalysisResult['kind'][] = source.role === 'TRA_VIDEO'
      ? ['REPRESENTATIVE_VIDEO_FRAMES']
      : [source.role === 'TRA_REFERENCE' ? 'TRA_REFERENCE' : 'LAYOUT_ANGLE', 'LAYOUT_BLUEPRINT'];
    return kinds.map(kind => ({ source, analyzer: { kind, model: kind === 'LAYOUT_BLUEPRINT' ? getLayoutAnalysisModel() : model,
      schemaVersion: LAYOUT_BLUEPRINT_SCHEMA_VERSION, contextSha256: kind === 'LAYOUT_BLUEPRINT' ? null : contextSha256 },
      evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const }));
  });
  if (!current) return { state: { version: 1, entries }, complete: entries.length === 0 };
  if (current.version !== 1 || !isDeepStrictEqual(current.entries.map(({ result: _result, ...binding }) => binding), entries)
    || current.entries.some(entry => entry.result && entry.result.kind !== entry.analyzer.kind)) throw changed();
  const state = structuredClone(current);
  const pending = state.entries.find(entry => entry.result === undefined);
  if (!pending) return { state, complete: true };
  const hydrated = inventory.find(item => item.identity.mediaId === pending.source.mediaId)!.source;
  const kind = pending.analyzer.kind;
  let result: PlanningSourceAnalysisResult;
  if (kind === 'REPRESENTATIVE_VIDEO_FRAMES') {
    const extracted = await getApprovedTraVideoFrames(hydrated);
    const frames = selectProviderVideoFrames(extracted.frames);
    if (extracted.sourceVideoContentHash !== pending.source.sha256 || frames.some(frame =>
      frame.sourceVideoMediaId !== pending.source.mediaId || frame.sourceVideoContentHash !== pending.source.sha256)) throw changed();
    onProviderOperationStart();
    result = { kind, analysis: await analyzeApprovedTraVideoFrames({ frames: extracted.frames, context: request.context }),
      analyzedFrames: frames.map(({ timestampMs, frameSha256 }) => ({ timestampMs, frameSha256 })) };
  } else {
    // Canonical hydration has already checked image/role compatibility.
    const image = hydrated.stored as StoredMediaFile;
    if (kind === 'LAYOUT_BLUEPRINT') {
      onProviderOperationStart();
      const layout = await getOrAnalyzeLayoutBlueprint(image, { analyzerModel: pending.analyzer.model });
      if (layout.contentHash !== pending.source.sha256 || layout.analyzerModel !== pending.analyzer.model) throw changed();
      result = { kind, layout };
    } else if (kind === 'LAYOUT_ANGLE') {
      result = { kind, angleDescription: await getOrAnalyzeContextualLayoutAngle(image, request.context, onProviderOperationStart) };
    } else {
      onProviderOperationStart();
      result = { kind, analysis: await analyzeTraSourceCreative(image, request.context) };
    }
  }
  pending.result = result;
  return { state, complete: state.entries.every(entry => entry.result !== undefined) };
}

export function composedSourceCatalog(state: PlanningSourceAnalysisState): ReferencePlanningCandidate[] {
  return state.entries.flatMap(entry => {
    if (entry.result?.kind !== 'LAYOUT_BLUEPRINT') return [];
    const cue = state.entries.find(other => other.source.mediaId === entry.source.mediaId && other.analyzer.kind !== 'LAYOUT_BLUEPRINT')?.result;
    const layout = entry.result.layout;
    return [{ referenceId: entry.source.mediaId, priority: 'user', sourceSha256: entry.source.sha256,
      analyzerModel: layout.analyzerModel, blueprint: layout.blueprint, angleDescription:
        (cue?.kind === 'LAYOUT_ANGLE' ? cue.angleDescription : cue?.kind === 'TRA_REFERENCE' ? cue.analysis.hookOrAngle : '').slice(0, 2000).trim() || 'No angle observed. Layout guidance only.' }];
  });
}
