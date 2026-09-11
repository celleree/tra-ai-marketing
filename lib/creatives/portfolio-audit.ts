import { MAX_PORTFOLIO_CREATIVES } from '@/lib/creatives/planned';

export type PortfolioAudit = {
  version: 1; model: string; conceptCount: number; executionNotes: string;
  groups: Array<{ conceptIndexes: number[]; proposition: string; distinction: string }>;
};
const text = { type: 'string', minLength: 1, maxLength: 1000 };
export function portfolioAuditSchema(count: number) {
  return { type: 'object', additionalProperties: false, required: ['groups', 'executionNotes'], properties: {
    executionNotes: text,
    groups: { type: 'array', minItems: 1, maxItems: count, items: { type: 'object', additionalProperties: false,
      required: ['conceptIndexes', 'proposition', 'distinction'], properties: {
        conceptIndexes: { type: 'array', minItems: 1, maxItems: count, items: { type: 'integer', minimum: 1, maximum: count } },
        proposition: text, distinction: text,
      } } },
  } };
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => key in value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 1000;

/** Coverage is deterministic; semantic grouping remains Astra's judgment, not proof of originality. */
export function parsePortfolioAudit(value: unknown): PortfolioAudit | null {
  if (!record(value) || !exact(value, ['version', 'model', 'conceptCount', 'executionNotes', 'groups']) || value.version !== 1
    || !isText(value.model) || value.model.length > 200 || !isText(value.executionNotes)
    || !Number.isInteger(value.conceptCount) || Number(value.conceptCount) < 2 || Number(value.conceptCount) > MAX_PORTFOLIO_CREATIVES
    || !Array.isArray(value.groups) || !value.groups.length || value.groups.length > Number(value.conceptCount)) return null;
  const indexes: number[] = [];
  for (const group of value.groups) {
    if (!record(group) || !exact(group, ['conceptIndexes', 'proposition', 'distinction']) || !isText(group.proposition)
      || !isText(group.distinction) || !Array.isArray(group.conceptIndexes) || !group.conceptIndexes.length) return null;
    for (const index of group.conceptIndexes) {
      if (!Number.isInteger(index) || index < 1 || index > Number(value.conceptCount)) return null;
      indexes.push(index);
    }
  }
  if (indexes.length !== value.conceptCount || new Set(indexes).size !== indexes.length) return null;
  return value as PortfolioAudit;
}
