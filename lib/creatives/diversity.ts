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


export type CreativeDiversityRepairDefectType =
  | 'SEMANTIC_DUPLICATE'
  | 'DUPLICATE_HEADLINE'
  | 'DUPLICATE_SO_WHAT'
  | 'DUPLICATE_PROPOSITION';

export type CreativeDiversityRepairDefect = {
  replacementIndex: number;
  type: CreativeDiversityRepairDefectType;
  relatedIndexes: number[];
  description: string;
};

export type CreativeDiversityRepairPlan = {
  replacementIndexes: number[];
  defects: CreativeDiversityRepairDefect[];
};

const formatIndexes = (indexes: number[]) => indexes.length === 2
  ? `${indexes[0]} and ${indexes[1]}`
  : `${indexes.slice(0, -1).join(', ')}, and ${indexes.at(-1)}`;

export function getCreativeDiversityRepairPlan(
  concepts: ReadonlyArray<CreativeConcept>,
  audit: PortfolioAudit,
): CreativeDiversityRepairPlan {
  if (!parsePortfolioAudit(audit) || audit.conceptCount !== concepts.length) return { replacementIndexes: [], defects: [] };

  const defects: CreativeDiversityRepairDefect[] = [];
  for (const group of [...audit.groups].sort((left, right) => Math.min(...left.conceptIndexes) - Math.min(...right.conceptIndexes))) {
    const relatedIndexes = [...group.conceptIndexes].sort((left, right) => left - right);
    if (relatedIndexes.length < 2) continue;
    for (const replacementIndex of relatedIndexes.slice(1)) defects.push({
      replacementIndex, type: 'SEMANTIC_DUPLICATE', relatedIndexes,
      description: `Concepts ${relatedIndexes.join(', ')} repeat a strategic proposition: ${group.proposition}`,
    });
  }

  const exactChecks = [
    { type: 'DUPLICATE_HEADLINE' as const, label: 'headlines',
      value: (concept: CreativeConcept) => normalizeMessage(concept.copy.headline) },
    { type: 'DUPLICATE_SO_WHAT' as const, label: 'SO WHAT surface messages',
      value: (concept: CreativeConcept) => normalizeMessage(concept.strategy.soWhat.surfaceMessage) },
    { type: 'DUPLICATE_PROPOSITION' as const, label: 'propositions',
      value: (concept: CreativeConcept) => concept.strategy.conceptDetails?.proposition
        ? normalizeMessage(concept.strategy.conceptDetails.proposition) : null },
  ];
  for (const check of exactChecks) {
    const groups = new Map<string, number[]>();
    concepts.forEach((concept, index) => {
      const value = check.value(concept);
      if (value !== null) groups.set(value, [...(groups.get(value) ?? []), index + 1]);
    });
    for (const relatedIndexes of groups.values()) {
      if (relatedIndexes.length < 2) continue;
      for (const replacementIndex of relatedIndexes.slice(1)) defects.push({
        replacementIndex, type: check.type, relatedIndexes,
        description: `Variations ${formatIndexes(relatedIndexes)} have duplicate ${check.label}.`,
      });
    }
  }

  const order: CreativeDiversityRepairDefectType[] = [
    'SEMANTIC_DUPLICATE', 'DUPLICATE_HEADLINE', 'DUPLICATE_SO_WHAT', 'DUPLICATE_PROPOSITION',
  ];
  defects.sort((left, right) => left.replacementIndex - right.replacementIndex || order.indexOf(left.type) - order.indexOf(right.type));
  return {
    replacementIndexes: [...new Set(defects.map(defect => defect.replacementIndex))].sort((left, right) => left - right),
    defects,
  };
}

export function getCreativeDiversityRepairIndexes(
  concepts: ReadonlyArray<CreativeConcept>,
  audit: PortfolioAudit,
): number[] {
  return getCreativeDiversityRepairPlan(concepts, audit).replacementIndexes;
}
