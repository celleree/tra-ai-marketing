import { parseGeneratedVideoFrameSelection, type GeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';

/** Operator approval of one real TRA frame. Never approval of claims or testimonials. */
export type ApprovedHumanFrame = {
  version: 1;
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
export const isApprovedHumanId = (value: unknown): value is string => typeof value === 'string' && /^human_[a-f0-9]{64}$/.test(value);
export type ApprovedHumanOption = Pick<ApprovedHumanFrame, 'id' | 'description' | 'sourceName'>;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const date = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function parseApprovedHumanFrame(value: unknown): ApprovedHumanFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = ['version', 'id', 'sourceName', 'description', 'source', 'extractionVersion', 'approvedBy', 'approvedAt', 'updatedAt', 'active'];
  const source = parseGeneratedVideoFrameSelection(record.source);
  if (Object.keys(record).length !== keys.length || !keys.every(key => key in record)
    || record.version !== 1 || !isApprovedHumanId(record.id) || !text(record.sourceName, 255)
    || !text(record.description, 500) || !text(record.approvedBy, 200) || !date(record.approvedAt) || !date(record.updatedAt)
    || Date.parse(record.updatedAt) < Date.parse(record.approvedAt) || typeof record.active !== 'boolean'
    || record.extractionVersion !== 'selected-png-v1' || !source || source.frames.length !== 1 || source.frames[0].frameIndex !== 0) return null;
  return { ...record, source } as ApprovedHumanFrame;
}
