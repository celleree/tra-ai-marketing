import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { getVideoIntelligenceStorage, type VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

// Server-only: never import this module from a client component.
export class ProviderSecretError extends Error {
  constructor(public readonly code: 'unavailable' | 'conflict' | 'invalid_input') {
    super(`Provider credential: ${code}`); this.name = 'ProviderSecretError';
  }
}
type Dependencies = { storage?: VideoIntelligenceStorage; masterKey?: string };
type Credential = { version: 1; revision: string; updatedAt: string; apiKey: string | null };
export type ProviderSecretStatus = { configured: boolean; revision: string | null; updatedAt: string | null };
const fail = (): never => { throw new ProviderSecretError('unavailable'); };
const hash = (operatorId: string) => {
  if (typeof window !== 'undefined' || !operatorId.trim()) return fail();
  return createHash('sha256').update(operatorId).digest('hex');
};
function master(deps: Dependencies): Buffer {
  const encoded = deps.masterKey ?? process.env.TRA_PROVIDER_SECRETS_MASTER_KEY ?? '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return fail();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) return fail();
  return key;
}
export function providerSecretsReady(): boolean {
  try { master({}); return typeof window === 'undefined'; } catch { return false; }
}
const location = (operatorId: string) => `provider-secrets/v1/${hash(operatorId)}/anthropic.json`;
const aad = (operatorId: string) => Buffer.from(`tra:provider-secrets:v1:anthropic:${hash(operatorId)}`);
function decrypt(bytes: Buffer, operatorId: string, key: Buffer): Credential {
  try {
    if (bytes.length > 4096) return fail();
    const envelope = JSON.parse(bytes.toString('utf8'));
    if (envelope.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') return fail();
    const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) return fail();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad(operatorId)); decipher.setAuthTag(tag);
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    if (value.version !== 1 || typeof value.revision !== 'string' || !/^[a-f0-9-]{36}$/.test(value.revision)
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
      || (value.apiKey !== null && !validKey(value.apiKey))) return fail();
    return value;
  } catch { return fail(); }
}
const validKey = (key: unknown): key is string => typeof key === 'string' && /^sk-ant-[A-Za-z0-9_-]{16,500}$/.test(key);
async function load(operatorId: string, deps: Dependencies) {
  const key = master(deps), storage = deps.storage ?? getVideoIntelligenceStorage();
  const stored = await storage.read(location(operatorId));
  return { key, storage, stored, value: stored ? decrypt(stored.bytes, operatorId, key) : null };
}
const status = (value: Credential | null): ProviderSecretStatus => ({ configured: Boolean(value?.apiKey), revision: value?.revision ?? null, updatedAt: value?.updatedAt ?? null });
export async function getProviderSecretStatus(operatorId: string, deps: Dependencies = {}): Promise<ProviderSecretStatus> {
  try { return status((await load(operatorId, deps)).value); } catch { return fail(); }
}
/** Internal provider execution only. There is deliberately no credential export HTTP endpoint. */
export async function getAnthropicCredential(operatorId: string, deps: Dependencies = {}): Promise<string | null> {
  try { return (await load(operatorId, deps)).value?.apiKey ?? null; } catch { return fail(); }
}
/** Null key removes it; encrypted tombstone preserves revision checks across remove/recreate races. */
export async function changeAnthropicCredential(operatorId: string, apiKey: unknown, revision: unknown, deps: Dependencies = {}): Promise<ProviderSecretStatus> {
  if ((apiKey !== null && !validKey(apiKey)) || (revision !== null && (typeof revision !== 'string' || !/^[a-f0-9-]{36}$/.test(revision)))) throw new ProviderSecretError('invalid_input');
  try {
    const current = await load(operatorId, deps);
    if ((current.value?.revision ?? null) !== revision) throw new ProviderSecretError('conflict');
    const value: Credential = { version: 1, revision: randomUUID(), updatedAt: new Date().toISOString(), apiKey };
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', current.key, iv);
    cipher.setAAD(aad(operatorId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const bytes = Buffer.from(JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
    if (!await current.storage.write(location(operatorId), bytes, current.stored?.etag ?? null)) throw new ProviderSecretError('conflict');
    return status(value);
  } catch (error) { if (error instanceof ProviderSecretError) throw error; return fail(); }
}
