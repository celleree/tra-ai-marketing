import { parseReferenceCuratedMetadata, type ReferenceCuratedMetadata } from '@/lib/references/types';
import { parseLayoutBlueprint, type LayoutBlueprint } from '@/lib/layouts/blueprint';

export type ReferenceSelection = {
  angleSource: string | null;
  layoutSource: string | null;
  referenceRelationship: 'matched' | 'mixed' | 'original';
};
export type ReferencePlanningCandidate = {
  referenceId: string;
  priority: 'user' | 'library';
  angleDescription: string;
  sourceSha256: string;
  analyzerModel: string;
  blueprint: LayoutBlueprint;
  reusableAngle?: ReusableReferenceAngle;
  curated?: ReferenceCuratedMetadata;
};
const isId = (value: unknown): value is string => typeof value === 'string' && /^media_[a-f0-9]{32}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => key in value);
/** Context-independent inspiration only; never approved evidence or selection rationale. */
export const REUSABLE_ANGLE_SCHEMA_VERSION = 1 as const;
export type ReusableReferenceAngle = {
  version: typeof REUSABLE_ANGLE_SCHEMA_VERSION;
  sourceSha256: string;
  analyzerModel: string;
  angleSummary: string;
};
export function parseReusableReferenceAngle(value: unknown): ReusableReferenceAngle | null {
  if (!record(value) || !exact(value, ['version', 'sourceSha256', 'analyzerModel', 'angleSummary'])
    || value.version !== REUSABLE_ANGLE_SCHEMA_VERSION
    || typeof value.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceSha256)
    || typeof value.analyzerModel !== 'string' || !value.analyzerModel.trim() || value.analyzerModel.length > 200
    || typeof value.angleSummary !== 'string' || !value.angleSummary.trim() || value.angleSummary.length > 2000) return null;
  return { ...value } as ReusableReferenceAngle;
}

export const referenceRelationship = (angle: string | null, layout: string | null): ReferenceSelection['referenceRelationship'] =>
  angle === null && layout === null ? 'original' : angle !== null && angle === layout ? 'matched' : 'mixed';

export function parseReferenceSelection(value: unknown): ReferenceSelection | null {
  if (!record(value) || !exact(value, ['angleSource', 'layoutSource', 'referenceRelationship'])
    || !(value.angleSource === null || isId(value.angleSource)) || !(value.layoutSource === null || isId(value.layoutSource))) return null;
  const relationship = referenceRelationship(value.angleSource, value.layoutSource);
  if (value.referenceRelationship !== relationship) return null;
  return { angleSource: value.angleSource, layoutSource: value.layoutSource, referenceRelationship: relationship };
}

export function referenceSelectionSchema(ids: string[]) {
  const source = { anyOf: [{ type: 'string', enum: ids }, { type: 'null' }] };
  const choice = ids.length ? source : { type: 'null' };
  return { type: 'object', additionalProperties: false, required: ['angleSource', 'layoutSource'],
    properties: { angleSource: choice, layoutSource: choice } };
}

/** Resolve model choices against the offered catalog; the application owns the relationship. */
export function resolveReferenceSelection(value: unknown, catalog: readonly ReferencePlanningCandidate[]): ReferenceSelection {
  if (!record(value) || !exact(value, ['angleSource', 'layoutSource'])) throw new Error('Invalid reference choices.');
  const valid = (id: unknown) => id === null || (isId(id) && catalog.some(item => item.referenceId === id));
  if (!valid(value.angleSource) || !valid(value.layoutSource)) throw new Error('Unavailable reference choice.');
  const angleSource = value.angleSource as string | null;
  const layoutSource = value.layoutSource as string | null;
  return { angleSource, layoutSource, referenceRelationship: referenceRelationship(angleSource, layoutSource) };
}

export function parseReferenceCatalog(value: unknown): ReferencePlanningCandidate[] | null {
  if (!Array.isArray(value) || value.length > 40) return null;
  try {
    const catalog = value.map(item => {
      if (!record(item) || !exact(item, [...('reusableAngle' in item ? ['reusableAngle'] : []), ...('curated' in item ? ['curated'] : []), 'referenceId', 'priority', 'angleDescription', 'sourceSha256', 'analyzerModel', 'blueprint'])
        || !isId(item.referenceId) || !['user', 'library'].includes(String(item.priority))
        || typeof item.angleDescription !== 'string' || !item.angleDescription.trim() || item.angleDescription.length > 2000
        || typeof item.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sourceSha256)
        || typeof item.analyzerModel !== 'string' || !item.analyzerModel.trim() || item.analyzerModel.length > 200) throw new Error('Invalid reference catalog.');
      if ('curated' in item && !parseReferenceCuratedMetadata(item.curated)) throw new Error('Invalid curated reference metadata.');
      const { reusableAngle: rawAngle, ...legacy } = item;
      const reusableAngle = parseReusableReferenceAngle(rawAngle);
      return { ...legacy, blueprint: parseLayoutBlueprint(item.blueprint),
        ...(reusableAngle?.sourceSha256 === item.sourceSha256 ? { reusableAngle } : {}),
      } as ReferencePlanningCandidate;
    });
    return new Set(catalog.map(item => item.referenceId)).size === catalog.length ? catalog : null;
  } catch { return null; }
}

export function selectedLayout(selection: ReferenceSelection, catalog: readonly ReferencePlanningCandidate[]): LayoutBlueprint | undefined {
  const resolved = resolveReferenceSelection({ angleSource: selection.angleSource, layoutSource: selection.layoutSource }, catalog);
  return resolved.layoutSource === null ? undefined : catalog.find(item => item.referenceId === resolved.layoutSource)!.blueprint;
}
