import {
  CREATIVE_CATEGORIES,
  isCreativeCategory,
  type CreativeCategoryId,
} from '@/lib/creative-categories';

import { TAX_DOCUMENT_SELECTIONS, type TaxDocumentSelection } from '@/lib/references/tax-documents';
import { parseReferenceSelection, type ReferenceSelection } from '@/lib/references/planning';

const awarenessStages = ['problem-aware', 'solution-aware', 'service-aware', 'action-ready'] as const;
const subjectSources = ['approved-tra-human', 'non-human'] as const;
const compositions = ['single-focus', 'split', 'stacked', 'grid', 'comparison'] as const;
const imageTreatments = ['photographic', 'illustrative', 'mixed-media', 'minimal-graphic', 'documentary'] as const;
const textDensities = ['low', 'medium', 'high'] as const;
const ctaTreatments = ['button', 'banner', 'inline', 'footer'] as const;
const typographyHierarchies = ['headline-dominant', 'balanced', 'proof-dominant', 'cta-dominant'] as const;

type AwarenessStage = (typeof awarenessStages)[number];
type SubjectSource = (typeof subjectSources)[number];

const conceptFields = ['angle', 'proposition', 'mainMessage', 'visualArchetype', 'visualMechanism', 'subject', 'environment', 'compositionInstructions'] as const;
export type CreativeConceptDetails = Record<(typeof conceptFields)[number], string> & { version: 1; objection: string | null };

export type CreativeStrategy = {
  referenceSelection?: ReferenceSelection; // Resolved by the app; absent on legacy plans.
  conceptDetails?: CreativeConceptDetails; // Absent on legacy saved plans; required for new planner output.
  category: CreativeCategoryId;
  awarenessStage: AwarenessStage;
  persona: string;
  painPoint: string;
  desiredOutcome: string;
  emotion: string;
  hook: string;
  cta: string;
  offer: string | null;
  soWhat: { surfaceMessage: string; functionalConsequence: string; meaningfulOutcome: string };
  execution: {
    taxDocumentReference?: TaxDocumentSelection; // Absent only on legacy saved plans.
    subjectSource: SubjectSource;
    composition: (typeof compositions)[number];
    imageTreatment: (typeof imageTreatments)[number];
    textDensity: (typeof textDensities)[number];
    ctaTreatment: (typeof ctaTreatments)[number];
    typographyHierarchy: (typeof typographyHierarchies)[number];
  };
  visualDirection: string;
};

const stringSchema = { type: 'string', minLength: 1, maxLength: 1000 };
const stringFields = ['persona', 'painPoint', 'desiredOutcome', 'emotion', 'hook', 'cta', 'visualDirection'] as const;
const soWhatFields = ['surfaceMessage', 'functionalConsequence', 'meaningfulOutcome'] as const;

export const CREATIVE_STRATEGY_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['category', 'awarenessStage', ...stringFields, 'offer', 'soWhat', 'execution', 'conceptDetails'],
  properties: {
    conceptDetails: { type: 'object', additionalProperties: false,
      required: ['version', ...conceptFields, 'objection'],
      properties: { version: { type: 'integer', enum: [1] },
        ...Object.fromEntries(conceptFields.map((field) => [field, stringSchema])),
        objection: { anyOf: [stringSchema, { type: 'null' }] } } },
    category: { type: 'string', enum: CREATIVE_CATEGORIES }, awarenessStage: { type: 'string', enum: awarenessStages },
    ...Object.fromEntries(stringFields.map((field) => [field, stringSchema])),
    offer: { anyOf: [stringSchema, { type: 'null' }] },
    soWhat: { type: 'object', additionalProperties: false, required: soWhatFields,
      properties: Object.fromEntries(soWhatFields.map((field) => [field, stringSchema])) },
    execution: { type: 'object', additionalProperties: false,
      required: ['taxDocumentReference', 'subjectSource', 'composition', 'imageTreatment', 'textDensity', 'ctaTreatment', 'typographyHierarchy'],
      properties: { taxDocumentReference: { type: 'string', enum: TAX_DOCUMENT_SELECTIONS },
        subjectSource: { type: 'string', enum: subjectSources }, composition: { type: 'string', enum: compositions },
        imageTreatment: { type: 'string', enum: imageTreatments }, textDensity: { type: 'string', enum: textDensities },
        ctaTreatment: { type: 'string', enum: ctaTreatments }, typographyHierarchy: { type: 'string', enum: typographyHierarchies } } },
  },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
const isEnum = <T extends readonly string[]>(value: unknown, values: T): value is T[number] =>
  typeof value === 'string' && values.includes(value as T[number]);
const parseString = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 1000 ? trimmed : null;
};

export function parseCreativeStrategy(value: unknown, hasApprovedHumanSource: boolean): CreativeStrategy | null {
  if (!isRecord(value) || !hasOnly(value, [...stringFields, 'category', 'awarenessStage', 'offer', 'soWhat', 'execution', ...('conceptDetails' in value ? ['conceptDetails'] : []), ...('referenceSelection' in value ? ['referenceSelection'] : [])])) return null;
  const referenceSelection = 'referenceSelection' in value ? parseReferenceSelection(value.referenceSelection) : undefined;
  if (referenceSelection === null) return null;
  let conceptDetails: CreativeConceptDetails | undefined;
  if ('conceptDetails' in value) {
    const details = value.conceptDetails;
    if (!isRecord(details) || !hasOnly(details, ['version', ...conceptFields, 'objection']) || details.version !== 1) return null;
    const fields = Object.fromEntries(conceptFields.map((field) => [field, parseString(details[field])]));
    if (Object.values(fields).some((field) => !field) || (details.objection !== null && !parseString(details.objection))) return null;
    conceptDetails = { ...fields as Record<(typeof conceptFields)[number], string>, version: 1,
      objection: details.objection === null ? null : parseString(details.objection)! };
  }
  if (!isEnum(value.awarenessStage, awarenessStages) || typeof value.category !== 'string' || !isCreativeCategory(value.category)) return null;
  const strings = Object.fromEntries(stringFields.map((field) => [field, parseString(value[field])])) as Record<(typeof stringFields)[number], string | null>;
  if (Object.values(strings).some((field) => !field) || (value.offer !== null && !parseString(value.offer))) return null;
  if (!isRecord(value.soWhat) || !hasOnly(value.soWhat, soWhatFields)) return null;
  const soWhatValue = value.soWhat;
  const soWhat = Object.fromEntries(soWhatFields.map((field) => [field, parseString(soWhatValue[field])]));
  if (Object.values(soWhat).some((field) => !field) || !isRecord(value.execution)) return null;
  const execution = value.execution;
  if (!hasOnly(execution, ['subjectSource', 'composition', 'imageTreatment', 'textDensity', 'ctaTreatment', 'typographyHierarchy', ...('taxDocumentReference' in execution ? ['taxDocumentReference'] : [])])
    || ('taxDocumentReference' in execution && !isEnum(execution.taxDocumentReference, TAX_DOCUMENT_SELECTIONS))
    || !isEnum(execution.subjectSource, subjectSources) || !isEnum(execution.composition, compositions)
    || !isEnum(execution.imageTreatment, imageTreatments) || !isEnum(execution.textDensity, textDensities)
    || !isEnum(execution.ctaTreatment, ctaTreatments) || !isEnum(execution.typographyHierarchy, typographyHierarchies)
    || (execution.subjectSource === 'approved-tra-human' && !hasApprovedHumanSource)) return null;
  return { category: value.category, awarenessStage: value.awarenessStage, ...strings as Record<(typeof stringFields)[number], string>,
    offer: value.offer === null ? null : parseString(value.offer)!,
    soWhat: soWhat as CreativeStrategy['soWhat'], execution: execution as CreativeStrategy['execution'],
    ...(conceptDetails ? { conceptDetails } : {}), ...(referenceSelection ? { referenceSelection } : {}) };
}
