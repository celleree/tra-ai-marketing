import { BatchControlsError } from '@/lib/creatives/batch-controls-error';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';

export const DEFAULT_PEOPLE_PERCENT = 50;
export const isPeoplePercent = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;

/** Nearest whole ad, with ties toward people. This counts ads, never people inside an ad. */
export function peopleMix(count: number, percent: number) {
  if (!Number.isInteger(count) || count < 1 || !isPeoplePercent(percent)) throw new BatchControlsError('Invalid ads-with-people mix.');
  const withPeople = Math.round(count * percent / 100);
  return { withPeople, withoutPeople: count - withPeople };
}

export function assertPeopleMixConcept(concept: Pick<PlannedCreativeConcept, 'index' | 'strategy'>, count: number, percent?: number) {
  if (percent === undefined) return; // Historical frozen plans keep their original behavior.
  const { withPeople } = peopleMix(count, percent);
  if (!Number.isInteger(concept.index) || concept.index < 1 || concept.index > count
    || (concept.strategy.execution.subjectSource === 'approved-tra-human') !== (concept.index <= withPeople)
    || (concept.index > withPeople && (concept.strategy.humanSourceId || concept.strategy.approvedHumanId))) {
    throw new BatchControlsError('The plan does not match Ads with people. No images were generated; preserve the requested mix or start a new portfolio.');
  }
}
export function assertPeopleMix(concepts: PlannedCreativeConcept[], count: number, percent?: number) {
  if (percent === undefined) return;
  if (concepts.length !== count || new Set(concepts.map(concept => concept.index)).size !== count) throw new BatchControlsError('The people mix does not cover the complete portfolio.');
  concepts.forEach(concept => assertPeopleMixConcept(concept, count, percent));
}
