import { CREATIVE_CATEGORY_LABELS } from '@/lib/creative-categories';
import { getOrAnalyzeLayoutBlueprint, type ResolvedLayoutBlueprint } from '@/lib/layouts/service';
import type { SelectedReferenceCreative } from '@/lib/ai/reference-selector';
import type { StoredMediaFile } from '@/lib/media/types';
import type { MediaStorage } from '@/lib/media/storage';
import type { ReferencePlanningCandidate } from '@/lib/references/planning';

/** Reuse the layout cache; uploading a reference never makes it an approved content source. */
export async function buildReferencePlanningCatalog(args: {
  storage: MediaStorage;
  selections: SelectedReferenceCreative[];
  uploaded?: { referenceId: string; source: StoredMediaFile; angleDescription: string; layout?: ResolvedLayoutBlueprint };
}): Promise<ReferencePlanningCandidate[]> {
  const catalog: ReferencePlanningCandidate[] = [];
  const add = (referenceId: string, priority: 'user' | 'library', angleDescription: string, layout: ResolvedLayoutBlueprint) => {
    catalog.push({ referenceId, priority, angleDescription: angleDescription.slice(0, 2000),
      sourceSha256: layout.contentHash, analyzerModel: layout.analyzerModel, blueprint: layout.blueprint });
  };
  if (args.uploaded) {
    const uploaded = args.uploaded;
    add(uploaded.referenceId, 'user', uploaded.angleDescription, uploaded.layout ?? await getOrAnalyzeLayoutBlueprint(uploaded.source));
  }
  for (const selection of args.selections) {
    if (catalog.some(item => item.referenceId === selection.item.id)) continue;
    const stored = await args.storage.readImageById(selection.item.id);
    if (!stored) throw new Error(`Reference ${selection.item.id} is unavailable.`);
    add(selection.item.id, 'library', `${CREATIVE_CATEGORY_LABELS[selection.item.angle]}: ${selection.selectionReason}`,
      await getOrAnalyzeLayoutBlueprint(stored));
  }
  return catalog;
}
