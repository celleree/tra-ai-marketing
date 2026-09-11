import type { CreativeStrategy } from '@/lib/creatives/strategy';
import { parsePortfolioAudit, type PortfolioAudit } from '@/lib/creatives/portfolio-audit';

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
 * Audited portfolios use semantic groups plus exact-duplicate checks. Legacy
 * callers retain structural checks. Neither path establishes human acceptance.
 */
export function getCreativeDiversityIssue(concepts: ReadonlyArray<CreativeConcept>, audit?: PortfolioAudit): string | null {
  if (audit) {
    if (!parsePortfolioAudit(audit) || audit.conceptCount !== concepts.length) return 'Portfolio audit does not cover this batch.';
    const duplicate = audit.groups.find(group => group.conceptIndexes.length > 1);
    if (duplicate) return `Concepts ${duplicate.conceptIndexes.join(', ')} repeat a strategic proposition: ${duplicate.proposition}`;
  }
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

      if (audit) {
        if (left.strategy.conceptDetails && right.strategy.conceptDetails
          && normalizeMessage(left.strategy.conceptDetails.proposition) === normalizeMessage(right.strategy.conceptDetails.proposition)) {
          return `${pair} have duplicate propositions.`;
        }
        continue; // Audited strategic distinctions need not change category or execution enums.
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
