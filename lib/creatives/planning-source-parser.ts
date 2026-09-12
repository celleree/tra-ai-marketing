import { isDeepStrictEqual } from 'node:util';
import { CREATIVE_CATEGORIES } from '@/lib/creative-categories';
import type { PlanningSourceAnalysisState } from '@/lib/creatives/planning-source-packet';
import { parseLayoutBlueprint } from '@/lib/layouts/blueprint';
import { MAX_CREATIVE_SOURCE_ASSETS } from '@/lib/media/source-limits';
import type { CreativeSourceSelection } from '@/lib/media/types';

const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).every(key => names.includes(key));
const analysisStrings = ['summary', 'visualStructure', 'hookOrAngle', 'offerOrCta', 'styleNotes'];
const analysisArrays = ['visibleText', 'preserve', 'avoid', 'unknowns'];
/** Legacy analysis readers allow empty required strings and retain saved arguments unchanged. */
export const validAnalysis = (v: unknown) => record(v)
  && analysisStrings.every(key => typeof v[key] === 'string')
  && analysisArrays.every(key => Array.isArray(v[key]) && v[key].every(item => typeof item === 'string'))
  && CREATIVE_CATEGORIES.includes(v.dominantCategory as (typeof CREATIVE_CATEGORIES)[number]);
export const validSourceLayout = (v: unknown) => {
  if (!record(v) || !hash(v.contentHash) || !text(v.analyzerModel) || typeof v.cacheHit !== 'boolean') return false;
  try { parseLayoutBlueprint(v.blueprint); return true; } catch { return false; }
};

/** Validate without trimming sources or inventing historical bindings. Absence is handled by legacy callers. */
export function parsePlanningSourceAnalysis(value: unknown,
  expected?: Array<CreativeSourceSelection & { sha256?: string }>, complete = false): PlanningSourceAnalysisState {
  const invalid = () => { throw new Error('Invalid or incomplete planning source analysis.'); };
  if (!record(value) || !keys(value, ['version', 'entries']) || value.version !== 1 || !Array.isArray(value.entries)
    || value.entries.length > MAX_CREATIVE_SOURCE_ASSETS * 2) return invalid();
  const sources = new Map<string, { role: string; sha256: string; kinds: Set<string> }>();
  for (const entry of value.entries) {
    if (!record(entry) || !keys(entry, ['source', 'analyzer', 'evidenceStatus', 'result'])
      || !record(entry.source) || !record(entry.analyzer) || entry.evidenceStatus !== 'UNVERIFIED_MODEL_OBSERVATION') return invalid();
    const s = entry.source, a = entry.analyzer;
    if (!keys(s, ['role', 'mediaId', 'sha256']) || typeof s.mediaId !== 'string' || !/^media_[a-f0-9]{32}$/.test(s.mediaId)
      || !hash(s.sha256) || !['TRA_VIDEO', 'TRA_REFERENCE', 'LAYOUT_REFERENCE'].includes(String(s.role))
      || !keys(a, ['kind', 'model', 'schemaVersion', 'contextSha256']) || !text(a.model) || a.schemaVersion !== 1
      || (a.kind === 'LAYOUT_BLUEPRINT' ? a.contextSha256 !== null : !hash(a.contextSha256))) return invalid();
    const kinds = s.role === 'TRA_VIDEO' ? ['REPRESENTATIVE_VIDEO_FRAMES']
      : [s.role === 'TRA_REFERENCE' ? 'TRA_REFERENCE' : 'LAYOUT_ANGLE', 'LAYOUT_BLUEPRINT'];
    if (typeof a.kind !== 'string' || !kinds.includes(a.kind)) return invalid();
    const binding = sources.get(s.mediaId) ?? { role: String(s.role), sha256: String(s.sha256), kinds: new Set<string>() };
    if (binding.role !== s.role || binding.sha256 !== s.sha256 || binding.kinds.has(a.kind)) return invalid();
    binding.kinds.add(a.kind); sources.set(s.mediaId, binding);
    const r = entry.result;
    if (r === undefined) { if (complete) return invalid(); continue; }
    if (!record(r) || r.kind !== a.kind) return invalid();
    if (r.kind === 'LAYOUT_BLUEPRINT') {
      if (!keys(r, ['kind', 'layout']) || !validSourceLayout(r.layout) || !record(r.layout)
        || !keys(r.layout, ['blueprint', 'contentHash', 'analyzerModel', 'cacheHit'])
        || r.layout.contentHash !== s.sha256 || r.layout.analyzerModel !== a.model
        || !isDeepStrictEqual(parseLayoutBlueprint(r.layout.blueprint), r.layout.blueprint)) return invalid();
    } else if (r.kind === 'LAYOUT_ANGLE') {
      if (!keys(r, ['kind', 'angleDescription']) || typeof r.angleDescription !== 'string' || r.angleDescription.length > 2000) return invalid();
    } else {
      if (!keys(r, ['kind', 'analysis', ...(r.kind === 'REPRESENTATIVE_VIDEO_FRAMES' ? ['analyzedFrames'] : [])])
        || !validAnalysis(r.analysis) || !record(r.analysis)
        || !keys(r.analysis, [...analysisStrings, ...analysisArrays, 'dominantCategory'])) return invalid();
      if (r.kind === 'REPRESENTATIVE_VIDEO_FRAMES' && (!Array.isArray(r.analyzedFrames)
        || r.analyzedFrames.length < 1 || r.analyzedFrames.length > 3
        || r.analyzedFrames.some(frame => !record(frame) || !keys(frame, ['timestampMs', 'frameSha256'])
          || !Number.isSafeInteger(frame.timestampMs) || Number(frame.timestampMs) < 0 || !hash(frame.frameSha256)))) return invalid();
    }
  }
  if (sources.size > MAX_CREATIVE_SOURCE_ASSETS || [...sources.values()].some(s => s.kinds.size !== (s.role === 'TRA_VIDEO' ? 1 : 2))) return invalid();
  if (expected && (expected.length !== sources.size || new Set(expected.map(s => s.mediaId)).size !== expected.length
    || expected.some(s => { const actual = sources.get(s.mediaId);
      return !actual || actual.role !== s.role || (s.sha256 !== undefined && actual.sha256 !== s.sha256); }))) return invalid();
  return structuredClone(value) as PlanningSourceAnalysisState;
}
