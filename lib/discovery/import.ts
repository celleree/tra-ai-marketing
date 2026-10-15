import { createHash } from 'node:crypto';
import { getMediaStorage } from '@/lib/media/local-storage';
import { prepareMediaImage, type MediaStorage } from '@/lib/media/storage';
import type { MediaAsset } from '@/lib/media/types';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { discoveryStorage } from './storage';
import { fingerprintImage, visualSimilarity, type ImageFingerprint } from './fingerprint';
type CatalogEntry = { mediaId: string; fingerprint: ImageFingerprint };
async function catalog(artifacts: VideoIntelligenceStorage, operator: string, mediaId: string, fingerprint: ImageFingerprint) {
  const key = `discovery/v1/operators/${operator}/image-fingerprints.json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await artifacts.read(key), entries = current ? JSON.parse(current.bytes.toString()) as CatalogEntry[] : [];
    const similar = entries.filter(entry => entry.mediaId !== mediaId).flatMap(entry => { const match = visualSimilarity(fingerprint, entry.fingerprint); return match ? [{ mediaId: entry.mediaId, ...match }] : []; }).slice(0, 10);
    if (entries.some(entry => entry.mediaId === mediaId)) return similar;
    if (await artifacts.write(key, Buffer.from(JSON.stringify([...entries.slice(-499), { mediaId, fingerprint }])), current?.etag ?? null)) return similar;
  }
  throw new Error('Visual fingerprint catalog changed. Retry the saved import.');
}
export async function storeSelectedImage(userId: string, file: File, dependencies: { artifacts?: VideoIntelligenceStorage; media?: MediaStorage } = {}) {
  const artifacts = dependencies.artifacts ?? discoveryStorage(), media = dependencies.media ?? getMediaStorage();
  const prepared = await prepareMediaImage(file), fingerprint = await fingerprintImage(prepared.buffer), imageSha256 = fingerprint.byteSha256;
  const operator = createHash('sha256').update(userId).digest('hex');
  const complete = async (saved: MediaAsset, reused: boolean) => ({ media: saved, imageSha256, fingerprint, reused, similarImages: await catalog(artifacts, operator, saved.id, fingerprint) });
  const key = `discovery/v1/operators/${operator}/images/${fingerprint.pixelSha256}.json`, prior = await artifacts.read(key);
  if (prior) {
    const existing = JSON.parse(prior.bytes.toString()) as { media: MediaAsset };
    if (await media.readImage(existing.media.fileName)) return complete(existing.media, true);
  }
  const saved = await media.saveImage(file);
  // If the write throws, its outcome may be unknown. Never delete media a committed receipt could reference.
  if (await artifacts.write(key, Buffer.from(JSON.stringify({ version: 1, imageSha256, fingerprint, media: saved })), prior?.etag ?? null)) return complete(saved, false);
  // A confirmed conflict means our receipt was not committed. Keep the winner's media.
  const winner = await artifacts.read(key);
  await media.deleteImage(saved.fileName);
  if (!winner) throw new Error('Image deduplication changed. Refresh and retry.');
  const existing = JSON.parse(winner.bytes.toString()) as { media: MediaAsset };
  return complete(existing.media, true);
}
