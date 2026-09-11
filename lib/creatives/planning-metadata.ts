import {
  parseCreativeStrategy,
  type CreativeStrategy,
} from '@/lib/creatives/strategy';
import { parseReferenceCatalog, selectedLayout, type ReferencePlanningCandidate } from '@/lib/references/planning';

export type CreativePlanningMetadata = {
  referenceCatalog?: ReferencePlanningCandidate[];
  strategy: CreativeStrategy;
  selectionReason: string;
  model: string;
  reasoningEffort: 'medium';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const parseText = (value: unknown, maximumLength: number) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximumLength ? trimmed : null;
};

export const parseCreativePlanning = (
  value: unknown
): CreativePlanningMetadata | null => {
  if (!isRecord(value) || !hasOnly(value, ['strategy', 'selectionReason', 'model', 'reasoningEffort', ...('referenceCatalog' in value ? ['referenceCatalog'] : [])])) {
    return null;
  }

  // This shape-only transport/storage parser NEVER approves a source; generation separately validates actual approved inputs.
  const strategy = parseCreativeStrategy(value.strategy, true);
  const selectionReason = parseText(value.selectionReason, 1000);
  const model = parseText(value.model, 200);
  if (!strategy || !selectionReason || !model || value.reasoningEffort !== 'medium') {
    return null;
  }

  const referenceCatalog = 'referenceCatalog' in value ? parseReferenceCatalog(value.referenceCatalog) : undefined;
  if (referenceCatalog === null) return null;
  if (strategy.referenceSelection) {
    if (!referenceCatalog) return null;
    try { selectedLayout(strategy.referenceSelection, referenceCatalog); } catch { return null; }
  }
  return { strategy, selectionReason, model, reasoningEffort: 'medium', ...(referenceCatalog ? { referenceCatalog } : {}) };
};
