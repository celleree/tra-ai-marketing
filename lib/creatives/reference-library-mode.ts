import { BatchControlsError } from '@/lib/creatives/batch-controls-error';
import type { ReferencePlanningCandidate } from '@/lib/references/planning';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';

export function assertReferenceLibraryConcept(concept: Pick<PlannedCreativeConcept, 'strategy'>,
  catalog: readonly ReferencePlanningCandidate[], enabled?: boolean) {
  if (enabled === undefined) return; // Frozen historical behavior.
  const selection = concept.strategy.referenceSelection;
  const library = catalog.filter(item => item.priority === 'library');
  if (enabled ? !library.some(item => item.referenceId === selection?.layoutSource)
    : library.length > 0) {
    throw new BatchControlsError(enabled
      ? 'Use reference library is On, but this ad has no eligible library layout. Review the selected library layout and explicitly Retry, or start a new portfolio with the control Off.'
      : 'Use reference library is Off, but the plan contains library layout guidance. Start a new portfolio.');
  }
}

export async function selectRequiredLibraryReferences<T>(enabled: boolean | undefined, select: () => Promise<T>): Promise<T> {
  try { return await select(); } catch (error) {
    if (!enabled || error instanceof BatchControlsError) throw error;
    throw new BatchControlsError('Use reference library is On, but selection could not complete. Review saved progress and provider status before explicit Retry; an interrupted call may have incurred cost. For prompt layouts, start a new portfolio with the control Off. No images were generated.');
  }
}

export function requireReferenceLibrarySelection(enabled: boolean | undefined, count: number) {
  if (enabled && count < 1) throw new BatchControlsError('Use reference library is On, but no eligible layout references were selected. Add a reference and start a new portfolio with the control On, or start one with the control Off.');
}
