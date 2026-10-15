import type { ReferencePlanningCandidate } from '@/lib/references/planning';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';

export function assertReferenceLibraryConcept(concept: Pick<PlannedCreativeConcept, 'strategy'>,
  catalog: readonly ReferencePlanningCandidate[], enabled?: boolean) {
  if (enabled === undefined) return; // Frozen historical behavior.
  const selection = concept.strategy.referenceSelection;
  const library = catalog.filter(item => item.priority === 'library');
  if (enabled ? !library.some(item => item.referenceId === selection?.layoutSource)
    : library.length > 0) {
    throw new Error(enabled
      ? 'Use reference library is On, but this ad has no eligible library layout. Select a valid library reference or turn the control Off.'
      : 'Use reference library is Off, but the plan contains library layout guidance. Start a new portfolio.');
  }
}

export function requireReferenceLibrarySelection(enabled: boolean | undefined, count: number) {
  if (enabled && count < 1) throw new Error('Use reference library is On, but no eligible layout references were selected. Add a reference or turn the control Off.');
}
