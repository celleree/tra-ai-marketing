import { DiscoveryError } from './errors';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { assertDeploymentRuntimeConsistent } from '@/lib/runtime/deployment';
import { LocalVideoIntelligenceStorage, R2VideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import type { Candidate, Search } from './model';
import type { ProviderRun } from './provider';
import type { MediaAsset } from '@/lib/media/types';
import type { VisualEvidence } from './analysis';
import type { ImageFingerprint } from './fingerprint';
export type DiscoverySession = {
  version: 1; id: string; createdAt: string; search: Search; run?: ProviderRun;
  sample: boolean; candidates: Candidate[]; exactDuplicates: number;
  submission?: 'reserved' | 'unknown' | 'submitted';
  imports: Record<string, MediaAsset>; feedback: Record<string, 'approved' | 'rejected'>;
  acquisitions?: Record<string, { method: 'provider-download' | 'operator-upload'; savedAt: string; imageSha256: string; reused: boolean }>;
  visualEvidence?: Record<string, VisualEvidence>;
  analysisAttempts?: Record<string, 'reserved' | 'unknown' | 'succeeded'>;
  analysisTokens?: Record<string, string>;
  analysisHistory?: Record<string, { attempt: 'reserved' | 'unknown' | 'succeeded'; token?: string; evidence?: VisualEvidence }>;
  fingerprints?: Record<string, ImageFingerprint>;
  similarImports?: Record<string, { mediaId: string; kind: 'identical-pixels' | 'possible-visual-variant'; distance: number }[]>;
};
// Reuse the tested conditional artifact store with a distinct versioned discovery keyspace.
export function discoveryStorage(): VideoIntelligenceStorage {
  assertDeploymentRuntimeConsistent();
  if (process.env.NODE_ENV !== 'production') return new LocalVideoIntelligenceStorage(path.resolve(process.cwd(), '.runtime', 'discovery'));
  const environment = process.env.VERCEL_ENV;
  if (environment !== 'preview' && environment !== 'production') throw new DiscoveryError('Discovery requires a known deployment environment.');
  for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) if (!process.env[key]?.trim()) throw new DiscoveryError('Discovery storage is not configured.');
  return new R2VideoIntelligenceStorage({ environment, accountId: process.env.R2_ACCOUNT_ID!, accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!, bucketName: process.env.R2_BUCKET_NAME! });
}
export function sessionKey(userId: string, id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new DiscoveryError('Invalid discovery session.');
  return `discovery/v1/operators/${createHash('sha256').update(userId).digest('hex')}/sessions/${id}.json`;
}
export async function loadSession(userId: string, id: string) {
  const store = discoveryStorage(), key = sessionKey(userId, id), snapshot = await store.read(key);
  if (!snapshot) throw new DiscoveryError('Discovery session was not found for this operator.');
  const session = JSON.parse(snapshot.bytes.toString()) as DiscoverySession;
  if (session.version !== 1 || session.id !== id) throw new DiscoveryError('Unsupported discovery session.');
  return { session, etag: snapshot.etag, key, store };
}
export async function saveSession(userId: string, session: DiscoverySession, expectedEtag: string | null) {
  if (!await discoveryStorage().write(sessionKey(userId, session.id), Buffer.from(JSON.stringify(session)), expectedEtag)) throw new DiscoveryError('Discovery changed in another request. Refresh and retry.');
}
export async function updateSession(userId: string, id: string, update: (session: DiscoverySession) => void) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const snapshot = await loadSession(userId, id); update(snapshot.session);
    try { await saveSession(userId, snapshot.session, snapshot.etag); return snapshot.session; }
    catch (error) { if (!(error instanceof Error) || !error.message.startsWith('Discovery changed')) throw error; }
  }
  throw new DiscoveryError('Discovery changed in another request. Refresh and retry.');
}
