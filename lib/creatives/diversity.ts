import type { CreativeStrategy } from '@/lib/creatives/strategy';

type CreativeCopy = { headline: string };

const normalizeMessage = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

const executionFields = [
  'composition',
  'imageTreatment',
  'textDensity',
  'ctaTreatment',
  'typographyHierarchy',
] as const;

type CreativeConcept = {
  strategy: CreativeStrategy;
  copy: Pick<CreativeCopy, 'headline'>;
};

const positions = (first: number, second: number) => `Variations ${first + 1} and ${second + 1}`;

/**
 * Checks planned variations for deterministic structural differences. This does
 * not establish semantic originality, which remains subject to human review.
 */
export function getCreativeDiversityIssue(concepts: ReadonlyArray<CreativeConcept>): string | null {
  for (let first = 0; first < concepts.length; first += 1) {
    for (let second = first + 1; second < concepts.length; second += 1) {
      const left = concepts[first];
      const right = concepts[second];
      const pair = positions(first, second);

      if (normalizeMessage(left.copy.headline) === normalizeMessage(right.copy.headline)) {
        return `${pair} have duplicate headlines.`;
      }
      if (normalizeMessage(left.strategy.soWhat.surfaceMessage) === normalizeMessage(right.strategy.soWhat.surfaceMessage)) {
        return `${pair} have duplicate SO WHAT surface messages.`;
      }

      const hasStrategicDifference = left.strategy.category !== right.strategy.category
        || left.strategy.awarenessStage !== right.strategy.awarenessStage;
      if (!hasStrategicDifference) {
        return `${pair} need a different category or awareness stage.`;
      }

      const executionDifferences = executionFields.filter((field) =>
        left.strategy.execution[field] !== right.strategy.execution[field],
      ).length;
      if (executionDifferences < 2) {
        return `${pair} need at least two execution differences.`;
      }
    }
  }

  return null;
}
