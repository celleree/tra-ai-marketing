import { CREATIVE_PLACEMENT_SPECS, isCreativePlacement, type CreativePlacement } from '@/lib/creatives/placements';
import { isApprovedHumanSourceRole, isCreativeSourceRole, isSourceRoleCompatibleWithMedia, type CreativeSourceRole, type MediaType } from '@/lib/media/types';

type VideoSource = {
  reference: string; mediaId: string; role: CreativeSourceRole; mediaType: MediaType;
  purpose: 'LAYOUT' | 'CONTENT' | 'HUMAN_IDENTITY' | 'VOICE_IDENTITY';
  permissionReference: string | null;
};
type SupportedText = { text: string; evidenceReferences: string[] };
type VideoShot = {
  durationSeconds: number; description: string; subject: 'NON_HUMAN' | 'SOURCE_HUMAN';
  humanSourceReference: string | null; sourceReferences: string[];
};
/** Offline planning only. Approval is brief review, not source/likeness permission or execution admission. */
export type VideoCreativeBrief = {
  version: 1; script: string; durationSeconds: number; placement: CreativePlacement;
  aspectRatio: '1:1' | '4:5' | '9:16'; sources: VideoSource[]; shots: VideoShot[];
  evidenceReferences: string[]; claims: SupportedText[]; disclaimers: SupportedText[];
  voiceSourceReference: string | null; approval: 'PENDING' | 'APPROVED' | 'REJECTED';
  provider: null; quotedCost: null;
};

const shape = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => key in value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= 12000;
const references = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 50 && value.every(item => text(item) && item.length <= 1000)
  && new Set(value).size === value.length;
const duration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 600;

/** Validates supplied references and shapes, never media truth, approved claims or actual permissions. */
export function parseVideoCreativeBrief(value: unknown): VideoCreativeBrief | null {
  if (!shape(value, ['version', 'script', 'durationSeconds', 'placement', 'aspectRatio', 'sources', 'shots',
    'evidenceReferences', 'claims', 'disclaimers', 'voiceSourceReference', 'approval', 'provider', 'quotedCost'])
    || value.version !== 1 || !text(value.script) || !duration(value.durationSeconds) || !isCreativePlacement(value.placement)
    || value.aspectRatio !== CREATIVE_PLACEMENT_SPECS[value.placement].aspectRatio
    || !references(value.evidenceReferences) || !Array.isArray(value.sources) || value.sources.length > 50
    || !Array.isArray(value.shots) || !value.shots.length || value.shots.length > 60
    || (value.approval !== 'PENDING' && value.approval !== 'APPROVED' && value.approval !== 'REJECTED')
    || value.provider !== null || value.quotedCost !== null) return null;
  const sources: VideoSource[] = [];
  for (const item of value.sources) {
    if (!shape(item, ['reference', 'mediaId', 'role', 'mediaType', 'purpose', 'permissionReference']) || !text(item.reference)
      || typeof item.mediaId !== 'string' || !/^media_[a-f0-9]{32}$/.test(item.mediaId) || typeof item.role !== 'string' || !isCreativeSourceRole(item.role)
      || (item.mediaType !== 'IMAGE' && item.mediaType !== 'VIDEO') || !isSourceRoleCompatibleWithMedia(item.role, item.mediaType)
      || (item.purpose !== 'LAYOUT' && item.purpose !== 'CONTENT' && item.purpose !== 'HUMAN_IDENTITY' && item.purpose !== 'VOICE_IDENTITY')
      || (item.permissionReference !== null && !text(item.permissionReference))
      || (item.role === 'LAYOUT_REFERENCE' && item.purpose !== 'LAYOUT')
      || ((item.purpose === 'HUMAN_IDENTITY' || item.purpose === 'VOICE_IDENTITY') && !isApprovedHumanSourceRole(item.role))) return null;
    sources.push({ reference: item.reference, mediaId: item.mediaId, role: item.role, mediaType: item.mediaType,
      purpose: item.purpose, permissionReference: item.permissionReference });
  }
  const sourceMap = new Map(sources.map(item => [item.reference, item]));
  if (sourceMap.size !== sources.length) return null;
  const voiceSource = value.voiceSourceReference;
  if (voiceSource !== null && (typeof voiceSource !== 'string' || sourceMap.get(voiceSource)?.purpose !== 'VOICE_IDENTITY')) return null;
  const shots: VideoShot[] = [];
  for (const item of value.shots) {
    if (!shape(item, ['durationSeconds', 'description', 'subject', 'humanSourceReference', 'sourceReferences'])
      || !duration(item.durationSeconds) || !text(item.description) || !references(item.sourceReferences)
      || item.sourceReferences.some(ref => !sourceMap.has(ref)) || (item.subject !== 'NON_HUMAN' && item.subject !== 'SOURCE_HUMAN')) return null;
    const human = item.humanSourceReference;
    if (item.subject === 'NON_HUMAN' ? human !== null : typeof human !== 'string'
      || sourceMap.get(human)?.purpose !== 'HUMAN_IDENTITY' || !item.sourceReferences.includes(human)) return null;
    shots.push({ durationSeconds: item.durationSeconds, description: item.description, subject: item.subject,
      humanSourceReference: human as string | null, sourceReferences: [...item.sourceReferences] });
  }
  if (Math.abs(shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) - value.durationSeconds) > 0.000001) return null;
  const evidence = new Set(value.evidenceReferences);
  const supported = (input: unknown): SupportedText[] | null => {
    if (!Array.isArray(input) || input.length > 50) return null;
    const parsed: SupportedText[] = [];
    for (const item of input) {
      if (!shape(item, ['text', 'evidenceReferences']) || !text(item.text) || !references(item.evidenceReferences)
        || !item.evidenceReferences.length || item.evidenceReferences.some(ref => !evidence.has(ref))) return null;
      parsed.push({ text: item.text, evidenceReferences: [...item.evidenceReferences] });
    }
    return parsed;
  };
  const claims = supported(value.claims), disclaimers = supported(value.disclaimers);
  if (!claims || !disclaimers) return null;
  return { version: 1, script: value.script, durationSeconds: value.durationSeconds, placement: value.placement,
    aspectRatio: CREATIVE_PLACEMENT_SPECS[value.placement].aspectRatio, sources, shots,
    evidenceReferences: [...value.evidenceReferences], claims, disclaimers, voiceSourceReference: voiceSource as string | null,
    approval: value.approval, provider: null, quotedCost: null };
}
