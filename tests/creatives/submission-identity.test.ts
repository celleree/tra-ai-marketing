import { describe, expect, it } from 'vitest';
import { createSubmissionIdentity, parseSubmissionId } from '@/lib/creatives/submission-id';

const memory = () => {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
describe('browser submission lifecycle', () => {
  it('reuses unresolved intent after refresh without storing prompts or company data', async () => {
    const storage = memory();
    const first = await createSubmissionIdentity('revision', () => storage).forInput('PRIVATE request');
    expect(parseSubmissionId(first)).toBe(first);
    expect(await createSubmissionIdentity('revision', () => storage).forInput('PRIVATE request')).toBe(first);
    expect(JSON.stringify([...storage.values])).not.toContain('PRIVATE');
  });
  it('deduplicates concurrent transport starts while preserving distinct requests and operations', async () => {
    const storage = memory(), state = createSubmissionIdentity('revision', () => storage);
    const ids = await Promise.all(Array.from({ length: 8 }, () => state.forInput('same request')));
    expect(new Set(ids).size).toBe(1);
    expect(await state.forInput('changed placement')).not.toBe(ids[0]);
    expect(await state.forInput('same request')).toBe(ids[0]);
    expect(await createSubmissionIdentity('direct-generation', () => storage).forInput('same request')).not.toBe(ids[0]);
  });
  it('retains incomplete results, permits explicit new paid intent, and ignores stale completion', async () => {
    const storage = memory(), state = createSubmissionIdentity('generation', () => storage);
    const first = await state.forInput('same request');
    state.completeGeneration(first, 2, 1, 1); expect(await state.forInput('same request')).toBe(first);
    state.reset(); const next = await state.forInput('same request'); expect(next).not.toBe(first);
    state.complete(first); expect(await state.forInput('same request')).toBe(next);
    state.completeGeneration(next, 2, 2, 0); expect(await state.forInput('same request')).not.toBe(next);
  });
  it('fails before dispatch when session storage is unavailable or corrupt', async () => {
    const unavailable = createSubmissionIdentity('generation', () => { throw new Error('disabled'); });
    await expect(unavailable.forInput('request')).rejects.toThrow('session storage');
    const storage = memory(), state = createSubmissionIdentity('generation', () => storage);
    await state.forInput('request'); for (const key of storage.values.keys()) storage.values.set(key, 'corrupt');
    await expect(createSubmissionIdentity('generation', () => storage).forInput('request')).rejects.toThrow('session storage');
    state.reset(); expect(parseSubmissionId(await state.forInput('request'))).not.toBeNull();
  });
  it('resets the selected unresolved action after switching among inputs', async () => {
    const storage = memory(), state = createSubmissionIdentity('revision', () => storage);
    const a = await state.forInput('A'), b = await state.forInput('B');
    expect(await state.forInput('A')).toBe(a); state.reset();
    expect(await state.forInput('A')).not.toBe(a);
    expect(await createSubmissionIdentity('revision', () => storage).forInput('B')).toBe(b);
  });
});
