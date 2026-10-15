import { describe, expect, it } from 'vitest';
import { reserveImageAttempt, settleImageAttempt, type ImageAttemptInput } from '@/lib/creatives/image-attempt-store';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';

const input = (operationId = 'creative-a'): ImageAttemptInput => ({ runId: 'portfolio-a', operationId, kind: 'primary',
  fingerprint: 'a'.repeat(64), budget: { purpose: 'production', primaryLimit: 2, fallbackLimit: 1 } });
const result = { sha256: 'b'.repeat(64), byteLength: 123 };
const claim = async (storage: MemoryPortfolioStorage, value = input()) => {
  const valueClaim = await reserveImageAttempt(value, storage, 0);
  if (valueClaim.status !== 'CLAIMED') throw new Error('Expected claim');
  return { ...value, token: valueClaim.token };
};

describe('durable image attempts and budgets', () => {
  it('admits exactly one concurrent claimant and reuses its completed result', async () => {
    const storage = new MemoryPortfolioStorage();
    const claims = await Promise.all(Array.from({ length: 8 }, () => reserveImageAttempt(input(), storage, 0)));
    expect(claims.filter(item => item.status === 'CLAIMED')).toHaveLength(1);
    expect(claims.filter(item => item.status === 'BUSY')).toHaveLength(7);
    const won = claims.find(item => item.status === 'CLAIMED')!;
    if (won.status !== 'CLAIMED') throw new Error('Expected claim');
    await settleImageAttempt({ ...input(), token: won.token }, { status: 'COMPLETE', result }, storage);
    expect(await reserveImageAttempt(input(), storage, 999_999)).toEqual({ status: 'COMPLETE', result });
    await claim(storage, input('creative-b'));
    await expect(claim(storage, input('creative-c'))).rejects.toThrow('budget');
  });
  it('never reclaims expired or unknown paid work, but accepts a matching late result', async () => {
    const storage = new MemoryPortfolioStorage(); const won = await claim(storage);
    expect(await reserveImageAttempt(input(), storage, 600_000)).toEqual({ status: 'UNKNOWN' });
    expect(await reserveImageAttempt(input(), storage, 900_000)).toEqual({ status: 'UNKNOWN' });
    await expect(reserveImageAttempt({ ...input(), kind: 'fallback' }, storage)).rejects.toThrow('confirmed retryable');
    await settleImageAttempt(won, { status: 'COMPLETE', result }, storage);
    expect(await reserveImageAttempt(input(), storage)).toEqual({ status: 'COMPLETE', result });
  });
  it('allows only one reserved fallback after a known retryable failure', async () => {
    const storage = new MemoryPortfolioStorage(); const won = await claim(storage);
    await settleImageAttempt(won, { status: 'FAILED', retryable: true }, storage);
    const fallback = { ...input(), kind: 'fallback' as const, fingerprint: 'c'.repeat(64) };
    const first = await reserveImageAttempt(fallback, storage, 10);
    expect(first.status).toBe('CLAIMED');
    expect(await reserveImageAttempt(fallback, storage, 11)).toEqual({ status: 'BUSY' });
    const other = await claim(storage, input('creative-b'));
    await settleImageAttempt(other, { status: 'FAILED', retryable: true }, storage);
    await expect(reserveImageAttempt({ ...input('creative-b'), kind: 'fallback' }, storage)).rejects.toThrow('budget');
  });
  it('denies fallback after terminal failure and never resets the consumed primary', async () => {
    const storage = new MemoryPortfolioStorage(); const won = await claim(storage);
    await settleImageAttempt(won, { status: 'FAILED', retryable: false, httpStatus: 401 }, storage);
    expect(await reserveImageAttempt(input(), storage)).toEqual({ status: 'FAILED', retryable: false, httpStatus: 401 });
    await expect(reserveImageAttempt({ ...input(), kind: 'fallback' }, storage)).rejects.toThrow('confirmed retryable');
  });
  it('binds input, budget and completion to the original intent and owner token', async () => {
    const storage = new MemoryPortfolioStorage(); const won = await claim(storage);
    await expect(reserveImageAttempt({ ...input(), fingerprint: 'd'.repeat(64) }, storage)).rejects.toThrow('inputs changed');
    await expect(reserveImageAttempt({ ...input(), budget: { ...input().budget, primaryLimit: 3 } }, storage)).rejects.toThrow('immutable');
    await expect(settleImageAttempt({ ...won, token: 'stale' }, { status: 'COMPLETE', result }, storage)).rejects.toThrow('inconsistent');
    await settleImageAttempt(won, { status: 'COMPLETE', result }, storage);
    await settleImageAttempt(won, { status: 'COMPLETE', result }, storage);
    await expect(settleImageAttempt(won, { status: 'COMPLETE', result: { ...result, sha256: 'e'.repeat(64) } }, storage)).rejects.toThrow('settled');
  });
  it('enforces one diagnostic attempt and no fallback across different operations', async () => {
    const storage = new MemoryPortfolioStorage();
    const diagnostic = { ...input(), budget: { purpose: 'diagnostic' as const, primaryLimit: 1, fallbackLimit: 0 } };
    await reserveImageAttempt(diagnostic, storage);
    await expect(reserveImageAttempt({ ...diagnostic, operationId: 'second' }, storage)).rejects.toThrow('budget');
    await expect(reserveImageAttempt({ ...diagnostic, budget: { ...diagnostic.budget, primaryLimit: 2 } }, new MemoryPortfolioStorage())).rejects.toThrow('inconsistent');
  });
  it('fails closed for malformed state and exhausted CAS without claiming work', async () => {
    const storage = new MemoryPortfolioStorage(); await claim(storage);
    const key = [...storage.data.keys()][0]; storage.data.set(key, { bytes: Buffer.from('{'), etag: '2' });
    await expect(reserveImageAttempt(input(), storage)).rejects.toThrow('inconsistent');
    const broken = new MemoryPortfolioStorage(); broken.write = async () => false;
    await expect(reserveImageAttempt(input(), broken)).rejects.toThrow('concurrently');
    expect(broken.data.size).toBe(0);
  });
  it('allows a new intentional run without silently changing an existing run', async () => {
    const storage = new MemoryPortfolioStorage(); const won = await claim(storage);
    await settleImageAttempt(won, { status: 'UNKNOWN' }, storage);
    expect((await reserveImageAttempt({ ...input(), runId: 'new-intent' }, storage)).status).toBe('CLAIMED');
    expect(await reserveImageAttempt(input(), storage)).toEqual({ status: 'UNKNOWN' });
  });
});
