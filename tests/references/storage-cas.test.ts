import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send = mocks.send; }, NoSuchKey: class extends Error {},
  GetObjectCommand: class { input; constructor(input: unknown) { this.input = input; } },
  PutObjectCommand: class { input; constructor(input: unknown) { this.input = input; } },
}));
let dir: string, bytes: string | null, revision: number, puts: number, intercept: (() => void) | undefined;
const addition = (id: string) => ({ media: { id, fileName: id + '.png', originalName: id, mimeType: 'image/png' as const, size: 12, url: '/api/media/' + id }, referenceType: 'layout' as const, angle: 'customer-problems' as const, angleSource: 'manual' as const });
const record = (id: string) => ({ ...addition(id).media, referenceType: 'layout', angle: 'customer-problems', angleSource: 'manual', addedAt: '2026-10-15T00:00:00Z' });
const denied = () => Object.assign(new Error('conflict'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
beforeEach(async () => {
  vi.resetModules(); mocks.send.mockReset(); dir = await mkdtemp(join(tmpdir(), 'tra-reference-cas-'));
  vi.stubEnv('REFERENCE_LIBRARY_INDEX', join(dir, 'index.json')); vi.stubEnv('NODE_ENV', 'production');
  for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) vi.stubEnv(key, 'offline-fixture');
  bytes = null; revision = 0; puts = 0; intercept = undefined;
  mocks.send.mockImplementation(async ({ input }) => {
    if (!('Body' in input)) {
      if (bytes === null) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      const snapshot = bytes;
      return { ETag: 'rev' + revision, Body: { transformToString: async () => snapshot } };
    }
    puts++; const current = intercept; intercept = undefined; current?.();
    if (input.IfNoneMatch ? bytes !== null : input.IfMatch !== 'rev' + revision) throw denied();
    bytes = input.Body; revision++; return {};
  });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
it('reapplies additions after create conflicts and deduplicates one batch', async () => {
  const store = await import('@/lib/references/storage');
  intercept = () => { bytes = JSON.stringify({ version: 3, items: [record('concurrent')] }); revision++; };
  const items = await store.addToReferenceLibrary([addition('new'), addition('new')]);
  expect(items.map(item => item.id)).toEqual(['new', 'concurrent']); expect(puts).toBe(2);
  expect(mocks.send.mock.calls[1][0].input.IfNoneMatch).toBe('*');
  expect(mocks.send.mock.calls[3][0].input.IfMatch).toBe('rev1');
});
it('reapplies edits onto the latest index without losing concurrent additions or unknown metadata', async () => {
  const store = await import('@/lib/references/storage');
  bytes = JSON.stringify({ version: 3, extension: { keep: true }, items: [{ ...record('old'), notes: 'clear me', tags: ['clear'], future: { preserved: true } }] });
  intercept = () => { const index = JSON.parse(bytes!); index.items.push(record('other')); bytes = JSON.stringify(index); revision++; };
  await store.updateReferenceMetadata('old', { notes: '', tags: [] });
  const saved = JSON.parse(bytes!); expect(saved.extension).toEqual({ keep: true });
  expect(saved.items.map((item: { id: string }) => item.id)).toEqual(['old', 'other']);
  expect(saved.items[0].future).toEqual({ preserved: true }); expect(saved.items[0]).not.toHaveProperty('notes'); expect(saved.items[0]).not.toHaveProperty('tags');
});
it.each(['broken', '{"version":3,"items":[{}]}', '{"version":4,"items":[]}', '{"version":3,"items":{}}'])('preserves unreadable/unsupported index bytes without PUT: %s', async initial => {
  bytes = initial; const store = await import('@/lib/references/storage');
  await expect(store.addToReferenceLibrary([addition('new')])).rejects.toThrow(); expect(bytes).toBe(initial); expect(puts).toBe(0);
});
it('stops after bounded conflicts and never writes unconditionally', async () => {
  const store = await import('@/lib/references/storage');
  mocks.send.mockImplementation(async ({ input }) => {
    if (!('Body' in input)) return { ETag: 'stable', Body: { transformToString: async () => JSON.stringify({ version: 3, items: [] }) } };
    expect(input.IfMatch).toBe('stable'); puts++; throw denied();
  });
  await expect(store.addToReferenceLibrary([addition('new')])).rejects.toThrow('concurrently'); expect(puts).toBe(4);
});
it('fails closed when an existing object has no revision and avoids no-op writes', async () => {
  const store = await import('@/lib/references/storage');
  mocks.send.mockResolvedValueOnce({ Body: { transformToString: async () => '{"version":3,"items":[]}' } });
  await expect(store.addToReferenceLibrary([addition('new')])).rejects.toThrow('revision'); expect(puts).toBe(0);
  await store.removeFromReferenceLibrary(['absent']); expect(puts).toBe(0);
});
it('serializes parallel local imports and preserves invalid local bytes', async () => {
  vi.stubEnv('NODE_ENV', 'test'); const store = await import('@/lib/references/storage');
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.addToReferenceLibrary([addition('item' + index)])));
  const saved = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')); expect(saved.items).toHaveLength(12);
  await writeFile(join(dir, 'index.json'), 'invalid');
  await expect(store.addToReferenceLibrary([addition('extra')])).rejects.toThrow();
  expect(await readFile(join(dir, 'index.json'), 'utf8')).toBe('invalid'); expect(mocks.send).not.toHaveBeenCalled();
});
