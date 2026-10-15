import { isCreativeCategory, type CreativeCategoryId } from '@/lib/creative-categories';
import { isCreativeFormat, type CreativeFormatId } from '@/lib/creative-formats';
import { isCreativePlacement, type CreativePlacement } from '@/lib/creatives/placements';
import { parseCreativeAdCopy, parseCreativeImageCopy } from '@/lib/creatives/copy-contract';
import type { CreativeAdCopy, CreativeImageCopy } from '@/lib/creatives/generated';
import { parseCreativeIdentity, type CreativeIdentity } from '@/lib/creatives/identity';

export type CopilotSavedCreativeEvidence = {
  adCopy: CreativeAdCopy;
  imageCopy: CreativeImageCopy | null;
  category: CreativeCategoryId;
  format: CreativeFormatId | null;
  placement: CreativePlacement | null;
  strategy: { hook: string; proposition: string | null; visualDirection: string;
    soWhat: { surfaceMessage: string; functionalConsequence: string; meaningfulOutcome: string } } | null;
  humanReviewStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
};

/** Explicit caller-supplied approved context, not a server-persisted company profile. */
export type CopilotContextSnapshot = {
  company: { reference: string; approvedText: string };
  creatives: { creativeId: string; identity: CreativeIdentity; sourceReferences: string[]; evidence?: CopilotSavedCreativeEvidence | null }[];
  performance: 'unknown';
};
export type CopilotModelIdentity = { provider: string; model: string };
type EvidenceStatement = { text: string; evidenceReferences: string[] };
type CreativeRecommendation = {
  text: string;
  soWhat: { surfaceMessage: string; functionalConsequence: string; meaningfulOutcome: string };
};
export type CopilotRecommendationRecord = {
  version: 1;
  generatedAt: string;
  model: CopilotModelIdentity;
  context: CopilotContextSnapshot;
  observations: EvidenceStatement[];
  inferences: EvidenceStatement[];
  unknowns: string[];
  performance: 'unknown';
} & ({ action: 'DO_NOTHING'; recommendation: null }
  | { action: 'PROPOSE_CREATIVE_TEST'; recommendation: CreativeRecommendation });

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const shape = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  record(value) && Object.keys(value).length === keys.length && keys.every(key => key in value);
const text = (value: unknown, max = 2000): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
const strings = (value: unknown, max = 50): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every(item => text(item));
const instant = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z');
};

/** Saved text/planning is an observed artifact, never approval of factual claims or actual pixels. */
export function parseCopilotSavedCreativeEvidence(value: unknown): CopilotSavedCreativeEvidence | null {
  if (!shape(value, ['adCopy', 'imageCopy', 'category', 'format', 'placement', 'strategy', 'humanReviewStatus'])
    || !shape(value.adCopy, ['primaryText', 'headline', 'description'])
    || !text(value.adCopy.primaryText, 1000) || !text(value.adCopy.headline, 1000)
    || typeof value.adCopy.description !== 'string' || value.adCopy.description.length > 1000
    || typeof value.category !== 'string' || !isCreativeCategory(value.category)
    || (value.format !== null && (typeof value.format !== 'string' || !isCreativeFormat(value.format)))
    || (value.placement !== null && !isCreativePlacement(value.placement))
    || ![null, 'PENDING', 'APPROVED', 'REJECTED'].includes(value.humanReviewStatus as string | null)) return null;
  const adCopy = parseCreativeAdCopy(value.adCopy)!;
  let imageCopy: CreativeImageCopy | null = null;
  if (value.imageCopy !== null) {
    if (!record(value.imageCopy) || Object.keys(value.imageCopy).some(key => !['headline', 'shortSupport', 'proofAttribution', 'cta', 'disclosure'].includes(key))
      || !Object.values(value.imageCopy).every(item => text(item, 1000))) return null;
    imageCopy = parseCreativeImageCopy(value.imageCopy);
    if (!imageCopy) return null;
  }
  let strategy: CopilotSavedCreativeEvidence['strategy'] = null;
  if (value.strategy !== null) {
    const input = value.strategy;
    if (!shape(input, ['hook', 'proposition', 'visualDirection', 'soWhat']) || !text(input.hook, 1000)
      || (input.proposition !== null && !text(input.proposition, 1000)) || !text(input.visualDirection, 1000)
      || !shape(input.soWhat, ['surfaceMessage', 'functionalConsequence', 'meaningfulOutcome'])
      || !Object.values(input.soWhat).every(item => text(item, 1000))) return null;
    strategy = { hook: input.hook, proposition: input.proposition as string | null, visualDirection: input.visualDirection,
      soWhat: { ...input.soWhat } as NonNullable<CopilotSavedCreativeEvidence['strategy']>['soWhat'] };
  }
  return { adCopy, imageCopy, category: value.category, format: value.format as CreativeFormatId | null,
    placement: value.placement as CreativePlacement | null, strategy,
    humanReviewStatus: value.humanReviewStatus as CopilotSavedCreativeEvidence['humanReviewStatus'] };
}

/** Checks identity shape only; callers remain responsible for approval and saved-record authority. */
export function parseCopilotContextSnapshot(value: unknown): CopilotContextSnapshot | null {
  if (!shape(value, ['company', 'creatives', 'performance']) || value.performance !== 'unknown'
    || !shape(value.company, ['reference', 'approvedText']) || !text(value.company.reference)
    || !text(value.company.approvedText, 50000) || !Array.isArray(value.creatives) || value.creatives.length > 50) return null;
  const creatives: CopilotContextSnapshot['creatives'] = [];
  for (const creative of value.creatives) {
    if (!record(creative) || !shape(creative, ['creativeId', 'identity', 'sourceReferences', ...('evidence' in creative ? ['evidence'] : [])]) || typeof creative.creativeId !== 'string'
      || !strings(creative.sourceReferences) || new Set(creative.sourceReferences).size !== creative.sourceReferences.length) return null;
    const identity = parseCreativeIdentity(creative.identity, creative.creativeId);
    if (!identity) return null;
    const evidence = creative.evidence === null || !('evidence' in creative) ? null : parseCopilotSavedCreativeEvidence(creative.evidence);
    if ('evidence' in creative && creative.evidence !== null && !evidence) return null;
    creatives.push({ creativeId: creative.creativeId, identity, sourceReferences: [...creative.sourceReferences],
      ...('evidence' in creative ? { evidence } : {}) });
  }
  if (new Set(creatives.map(item => item.creativeId)).size !== creatives.length) return null;
  return { company: { reference: value.company.reference, approvedText: value.company.approvedText }, creatives, performance: 'unknown' };
}

/** No provider/model defaults or executable tools. Free text still requires human creative/compliance review. */
export function parseCopilotRecommendation(
  value: unknown, suppliedContext: unknown, suppliedModel: unknown,
): CopilotRecommendationRecord | null {
  const context = parseCopilotContextSnapshot(suppliedContext);
  if (!context || !shape(suppliedModel, ['provider', 'model']) || !text(suppliedModel.provider, 200)
    || !text(suppliedModel.model, 200) || !shape(value, ['version', 'generatedAt', 'action', 'observations', 'inferences', 'recommendation', 'unknowns', 'performance'])
    || value.version !== 1 || !instant(value.generatedAt) || value.performance !== 'unknown' || !strings(value.unknowns)) return null;
  const allowed = new Set([context.company.reference, ...context.creatives.flatMap(item => [item.creativeId, ...item.sourceReferences])]);
  const statements = (input: unknown): EvidenceStatement[] | null => {
    if (!Array.isArray(input) || input.length > 50) return null;
    const result: EvidenceStatement[] = [];
    for (const item of input) {
      if (!shape(item, ['text', 'evidenceReferences']) || !text(item.text) || !strings(item.evidenceReferences)
        || !item.evidenceReferences.length || item.evidenceReferences.some(ref => !allowed.has(ref))) return null;
      result.push({ text: item.text, evidenceReferences: [...item.evidenceReferences] });
    }
    return result;
  };
  const observations = statements(value.observations), inferences = statements(value.inferences);
  if (!observations || !inferences) return null;
  const base = { version: 1 as const, generatedAt: value.generatedAt, context,
    model: { provider: suppliedModel.provider, model: suppliedModel.model }, observations, inferences,
    unknowns: [...value.unknowns], performance: 'unknown' as const };
  if (value.action === 'DO_NOTHING') return value.recommendation === null ? { ...base, action: 'DO_NOTHING', recommendation: null } : null;
  if (value.action !== 'PROPOSE_CREATIVE_TEST' || !inferences.length
    || !shape(value.recommendation, ['text', 'soWhat']) || !text(value.recommendation.text)
    || !shape(value.recommendation.soWhat, ['surfaceMessage', 'functionalConsequence', 'meaningfulOutcome'])
    || !Object.values(value.recommendation.soWhat).every(item => text(item))) return null;
  const chain = value.recommendation.soWhat as CreativeRecommendation['soWhat'];
  if (new Set(Object.values(chain).map(item => item.trim().toLowerCase())).size !== 3) return null;
  return { ...base, action: 'PROPOSE_CREATIVE_TEST', recommendation: { text: value.recommendation.text, soWhat: { ...chain } } };
}
