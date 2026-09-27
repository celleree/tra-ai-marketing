import { emitProviderReuse } from '@/lib/ai/provider-telemetry';
import { listAllReferenceLibrary } from '@/lib/references/storage';
import { parseReferenceCuratedMetadata } from '@/lib/references/types';
import { createHash } from 'node:crypto';
import { checkpointPaidPreparation } from '@/lib/creatives/preparation-checkpoint';
import { analyzeReusableReferenceAngle } from '@/lib/ai/openai';
import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import { getLayoutBlueprintCache, getOrAnalyzeLayoutBlueprint, type ResolvedLayoutBlueprint } from '@/lib/layouts/service';
import type { SelectedReferenceCreative } from '@/lib/ai/reference-selector';
import type { StoredMediaFile } from '@/lib/media/types';
import type { MediaStorage } from '@/lib/media/storage';
import { parseReusableReferenceAngle, REUSABLE_ANGLE_SCHEMA_VERSION, type ReferencePlanningCandidate } from '@/lib/references/planning';

/** Reuse the layout cache; uploading a reference never makes it an approved content source. */
export async function buildReferencePlanningCatalog(args: {
  storage: MediaStorage;
  selections: SelectedReferenceCreative[];
  uploaded?: { referenceId: string; source: StoredMediaFile; angleDescription: string; layout?: ResolvedLayoutBlueprint };
}): Promise<ReferencePlanningCandidate[]> {
  const catalog: ReferencePlanningCandidate[] = [];
  const layoutFor = (id: string, source: StoredMediaFile) => checkpointPaidPreparation(`reference-layout:${id}`,
    { id, sha256: createHash('sha256').update(source.buffer).digest('hex') }, () => getOrAnalyzeLayoutBlueprint(source));
  const add = (referenceId: string, priority: 'user' | 'library', angleDescription: string, layout: ResolvedLayoutBlueprint) => {
    catalog.push({ referenceId, priority, angleDescription: angleDescription.slice(0, 2000),
      sourceSha256: layout.contentHash, analyzerModel: layout.analyzerModel, blueprint: layout.blueprint });
  };
  if (args.uploaded) {
    const uploaded = args.uploaded;
    add(uploaded.referenceId, 'user', uploaded.angleDescription, uploaded.layout ?? await layoutFor(uploaded.referenceId, uploaded.source));
  }
  for (const selection of args.selections) {
    if (catalog.some(item => item.referenceId === selection.item.id)) continue;
    const stored = await args.storage.readImageById(selection.item.id);
    if (!stored) throw new Error(`Reference ${selection.item.id} is unavailable.`);
    add(selection.item.id, 'library', `${CREATIVE_CATEGORY_LABELS[selection.item.angle]}: ${selection.selectionReason}`,
      await layoutFor(selection.item.id, stored));
  }
  return catalog;
}

/** Enrich one catalog entry per advance; callers checkpoint before any subsequent provider work. */
export async function advanceReferenceAngles(
  catalog: ReferencePlanningCandidate[], storage: MediaStorage, onProviderOperationStart: () => void,
): Promise<ReferencePlanningCandidate[] | null> {
  const model = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.6-terra';
  const pending = catalog.find(item => {
    const value = parseReusableReferenceAngle(item.reusableAngle);
    return !value || value.sourceSha256 !== item.sourceSha256 || value.analyzerModel !== model;
  });
  if (!pending) return null;
  const source = await storage.readImageById(pending.referenceId);
  if (!source || createHash('sha256').update(source.buffer).digest('hex') !== pending.sourceSha256) {
    throw new Error(`Reference ${pending.referenceId} is unavailable or changed. Start fresh preparation.`);
  }
  const cache = getLayoutBlueprintCache();
  let reusableAngle = await cache.readAngle(pending.sourceSha256, model);
  if (reusableAngle) emitProviderReuse('source-reference-analysis', model);
  if (!reusableAngle) {
    onProviderOperationStart();
    const analysis = await analyzeReusableReferenceAngle(source);
    reusableAngle = parseReusableReferenceAngle({ version: REUSABLE_ANGLE_SCHEMA_VERSION,
      sourceSha256: pending.sourceSha256, analyzerModel: model, angleSummary: analysis.hookOrAngle });
    if (!reusableAngle) throw new Error('Invalid reusable angle analysis. Explicit retry required.');
    await cache.writeAngle(reusableAngle);
  }
  return catalog.map(item => item === pending ? { ...item, reusableAngle } : item);
}

/** Freeze editorial guidance for the new plan, independently of image-analysis identities. */
export async function withCuratedReferenceMetadata(catalog: ReferencePlanningCandidate[]): Promise<ReferencePlanningCandidate[]> {
  if (!catalog.length) return catalog;
  const records = await listAllReferenceLibrary();
  return catalog.map(({ curated: _previous, ...item }) => {
    const curated = parseReferenceCuratedMetadata(records.find(record => record.id === item.referenceId));
    return { ...item, ...(curated && Object.keys(curated).length ? { curated } : {}) };
  });
}
