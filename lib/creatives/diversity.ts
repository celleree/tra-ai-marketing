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


/**
 * Return the exact concept indexes that should be replaced after an audited
 * diversity failure. The earliest concept in each semantic duplicate group is
 * kept as the accepted anchor; later duplicates are replaceable. Exact-copy
 * duplicates outside those groups are also repaired without touching their
 * earliest occurrence.
 */
export function getCreativeDiversityRepairIndexes(
  concepts: ReadonlyArray<CreativeConcept>,
  audit: PortfolioAudit,
): number[] {
  if (!parsePortfolioAudit(audit) || audit.conceptCount !== concepts.length) return [];

  const replace = new Set<number>();
  for (const group of audit.groups) {
    if (group.conceptIndexes.length < 2) continue;
    const sorted = [...group.conceptIndexes].sort((left, right) => left - right);
    sorted.slice(1).forEach(index => replace.add(index));
  }

  for (let first = 0; first < concepts.length; first += 1) {
    for (let second = first + 1; second < concepts.length; second += 1) {
      const left = concepts[first];
      const right = concepts[second];
      const exactDuplicate = normalizeMessage(left.copy.headline) === normalizeMessage(right.copy.headline)
        || normalizeMessage(left.strategy.soWhat.surfaceMessage) === normalizeMessage(right.strategy.soWhat.surfaceMessage)
        || Boolean(left.strategy.conceptDetails && right.strategy.conceptDetails
          && normalizeMessage(left.strategy.conceptDetails.proposition) === normalizeMessage(right.strategy.conceptDetails.proposition));
      if (exactDuplicate) replace.add(second + 1);
    }
  }

  return [...replace].sort((left, right) => left - right);
}
