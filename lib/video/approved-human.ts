import { parseGeneratedVideoFrameSelection, type GeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import { parseSourceOverlayDecision, type SourceOverlayDecision } from '@/lib/video/source-overlay-contract';

/** Operator approval of one real TRA frame. Never approval of claims or testimonials. */
type ApprovedHumanFrameBase = {
  id: string;
  sourceName: string;
  description: string;
  source: GeneratedVideoFrameSelection;
  extractionVersion: 'selected-png-v1';
  approvedBy: string;
  approvedAt: string;
  updatedAt: string;
  active: boolean;
};
export type ApprovedHumanFrame = ApprovedHumanFrameBase & (
  | { version: 1 }
  | { version: 2; sourceOverlay: SourceOverlayDecision }
);
export const isApprovedHumanId = (value: unknown): value is string => typeof value === 'string' && /^human_[a-f0-9]{64}$/.test(value);
export const APPROVED_HUMAN_SOURCE_PREFIX = 'approved-human:' as const;
export const approvedHumanSourceId = (id: string) => {
  if (!isApprovedHumanId(id)) throw new Error('Invalid approved-human ID.');
  return `${APPROVED_HUMAN_SOURCE_PREFIX}${id}`;
};
export const parseApprovedHumanSourceId = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.startsWith(APPROVED_HUMAN_SOURCE_PREFIX)) return null;
  const id = value.slice(APPROVED_HUMAN_SOURCE_PREFIX.length);
  return isApprovedHumanId(id) && value === approvedHumanSourceId(id) ? id : null;
};
export type ApprovedHumanOption = Pick<ApprovedHumanFrame, 'id' | 'description' | 'sourceName'>;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const date = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function parseApprovedHumanFrame(value: unknown): ApprovedHumanFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = ['version', 'id', 'sourceName', 'description', 'source', 'extractionVersion', 'approvedBy', 'approvedAt', 'updatedAt', 'active'];
  const source = parseGeneratedVideoFrameSelection(record.source);
  const sourceOverlay = record.version === 2 ? parseSourceOverlayDecision(record.sourceOverlay) : null;
  if (Object.keys(record).length !== keys.length + (record.version === 2 ? 1 : 0) || !keys.every(key => key in record)
    || ![1, 2].includes(record.version as number) || (record.version === 2 && (!sourceOverlay || sourceOverlay.status === 'UNSAFE'))
    || !isApprovedHumanId(record.id) || !text(record.sourceName, 255)
    || !text(record.description, 500) || !text(record.approvedBy, 200) || !date(record.approvedAt) || !date(record.updatedAt)
    || Date.parse(record.updatedAt) < Date.parse(record.approvedAt) || typeof record.active !== 'boolean'
    || record.extractionVersion !== 'selected-png-v1' || !source || source.frames.length !== 1 || source.frames[0].frameIndex !== 0) return null;
  return record.version === 2 ? { ...record, version: 2, source, sourceOverlay: sourceOverlay! } as ApprovedHumanFrame
    : { ...record, version: 1, source } as ApprovedHumanFrame;
}
