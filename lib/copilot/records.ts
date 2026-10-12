import { parseCreativeIdentity, type CreativeIdentity } from '@/lib/creatives/identity';

/** Explicit caller-supplied approved context, not a server-persisted company profile. */
export type CopilotContextSnapshot = {
  company: { reference: string; approvedText: string };
  creatives: { creativeId: string; identity: CreativeIdentity; sourceReferences: string[] }[];
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

/** Checks identity shape only; callers remain responsible for approval and saved-record authority. */
export function parseCopilotContextSnapshot(value: unknown): CopilotContextSnapshot | null {
  if (!shape(value, ['company', 'creatives', 'performance']) || value.performance !== 'unknown'
    || !shape(value.company, ['reference', 'approvedText']) || !text(value.company.reference)
    || !text(value.company.approvedText, 50000) || !Array.isArray(value.creatives) || value.creatives.length > 50) return null;
  const creatives: CopilotContextSnapshot['creatives'] = [];
  for (const creative of value.creatives) {
    if (!shape(creative, ['creativeId', 'identity', 'sourceReferences']) || typeof creative.creativeId !== 'string'
      || !strings(creative.sourceReferences) || new Set(creative.sourceReferences).size !== creative.sourceReferences.length) return null;
    const identity = parseCreativeIdentity(creative.identity, creative.creativeId);
    if (!identity) return null;
    creatives.push({ creativeId: creative.creativeId, identity, sourceReferences: [...creative.sourceReferences] });
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
