import { createHash } from 'node:crypto';
import { parseApprovedHumanFrame, type ApprovedHumanFrame } from '@/lib/video/approved-human';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

const KEY = 'approved-humans/v1/index.json';
export const approvedHumanId = (source: ApprovedHumanFrame['source']) => `human_${createHash('sha256')
  .update(JSON.stringify([source.sourceVideoMediaId, source.sourceVideoContentHash, source.frames[0].libraryFrameId,
    source.frames[0].approvedPngSha256, 'selected-png-v1'])).digest('hex')}`;

async function read(storage: VideoIntelligenceStorage) {
  const stored = await storage.read(KEY);
  if (!stored) return { records: [] as ApprovedHumanFrame[], etag: null };
  const value = JSON.parse(stored.bytes.toString('utf8')) as { version?: unknown; records?: unknown[] };
  if (value.version !== 1 || !Array.isArray(value.records)) throw new Error('Approved-human library is invalid.');
  const records = value.records.map(parseApprovedHumanFrame);
  if (records.some(record => !record || record.id !== approvedHumanId(record.source))
    || new Set(records.map(record => record?.id)).size !== records.length) throw new Error('Approved-human records are invalid.');
  return { records: records as ApprovedHumanFrame[], etag: stored.etag };
}
export const listApprovedHumanFrames = async (storage = getVideoIntelligenceStorage()) => (await read(storage)).records;

/** Reuse the video store's local/R2 CAS so simultaneous curation does not lose records. */
async function update(change: (records: ApprovedHumanFrame[]) => ApprovedHumanFrame[], storage: VideoIntelligenceStorage) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await read(storage);
    const records = change(current.records);
    if (records.some(record => !parseApprovedHumanFrame(record))) throw new Error('Invalid approved-human update.');
    if (await storage.write(KEY, Buffer.from(JSON.stringify({ version: 1, records })), current.etag)) return records;
  }
  throw new Error('The human library changed concurrently. Try again.');
}

/** Caller must validate fresh source-bound PNGs and the operator's preview hash first. */
export async function saveApprovedHumanFrame(input: ApprovedHumanFrame, storage = getVideoIntelligenceStorage()) {
  const record = parseApprovedHumanFrame(input);
  if (!record || record.id !== approvedHumanId(record.source)) throw new Error('Invalid approved-human record.');
  const records = await update(current => {
    const existing = current.find(item => item.id === record.id);
    if (existing) return current.map(item => item.id === record.id ? { ...item, active: true, updatedAt: record.updatedAt } : item);
    return [...current, record];
  }, storage);
  return records.find(item => item.id === record.id)!;
}

/** Deactivation retains source and original approval provenance; reactivation is validated by the caller. */
export async function setApprovedHumanActive(id: string, active: boolean, storage = getVideoIntelligenceStorage(), now = new Date().toISOString()) {
  const records = await update(current => {
    if (!current.some(item => item.id === id)) throw new Error('Approved human was not found.');
    return current.map(item => item.id === id ? { ...item, active, updatedAt: now } : item);
  }, storage);
  return records.find(item => item.id === id)!;
}
