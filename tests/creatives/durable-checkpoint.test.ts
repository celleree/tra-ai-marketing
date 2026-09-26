import { describe, expect, it, vi } from 'vitest';
import { runDurableCheckpoint, submissionRunId } from '@/lib/creatives/durable-checkpoint';
import { MemoryPortfolioStorage } from '../fixtures/creative-portfolio';

const input = { context: 'Approved fixture', count: 2 };
describe('durable paid-operation checkpoints', () => {
  it('binds the run to authenticated operator, operation and submission', () => {
    const id = crypto.randomUUID(); const first = submissionRunId('operator', id, 'generate');
    expect(submissionRunId('operator', id, 'generate')).toBe(first);
    expect(submissionRunId('other', id, 'generate')).not.toBe(first);
    expect(submissionRunId('operator', id, 'revise')).not.toBe(first);
    expect(() => submissionRunId('operator', 'bad', 'generate')).toThrow('identity');
  });
  it('claims one concurrent execution and replays the confirmed result', async () => {
    const storage = new MemoryPortfolioStorage(); let release!: () => void;
    const work = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return { plan: ['a', 'b'] }; });
    const first = runDurableCheckpoint('run', 'plan', input, work, { storage });
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(1));
    await expect(runDurableCheckpoint('run', 'plan', input, work, { storage })).rejects.toMatchObject({ status: 202 });
    release(); const saved = await first; saved.plan.push('caller mutation');
    expect(await runDurableCheckpoint('run', 'plan', input, work, { storage })).toEqual({ plan: ['a', 'b'] });
    expect(work).toHaveBeenCalledTimes(1);
    await expect(runDurableCheckpoint('run', 'plan', { ...input, count: 3 }, work, { storage })).rejects.toThrow('inputs changed');
  });
  it('blocks ambiguous failures and expired paid work without repurchase', async () => {
    const storage = new MemoryPortfolioStorage(); const work = vi.fn(async () => { throw new Error('Provider disconnected'); });
    await expect(runDurableCheckpoint('failed', 'plan', input, work, { storage })).rejects.toThrow('disconnected');
    await expect(runDurableCheckpoint('failed', 'plan', input, work, { storage })).rejects.toMatchObject({ status: 409 });
    let release!: () => void; let time = 0;
    const pending = runDurableCheckpoint('expired', 'plan', input, async () => { await new Promise<void>(resolve => { release = resolve; }); return {}; }, { storage, now: () => time });
    await vi.waitFor(() => expect(release).toBeDefined()); time = 600_000;
    await expect(runDurableCheckpoint('expired', 'plan', input, work, { storage, now: () => time })).rejects.toMatchObject({ status: 409 });
    release(); await expect(pending).rejects.toThrow('unavailable'); expect(work).toHaveBeenCalledTimes(1);
  });
  it('permits explicitly safe finalization retry and rejects stale owners after safe expiry', async () => {
    const storage = new MemoryPortfolioStorage(); const options = { storage, safeToResume: true };
    await expect(runDurableCheckpoint('run', 'finalize', input, async () => { throw new Error('Storage outage'); }, options)).rejects.toThrow('outage');
    expect(await runDurableCheckpoint('run', 'finalize', input, async assert => { await assert(); return { saved: true }; }, options)).toEqual({ saved: true });
    let time = 0, release!: () => void;
    const expired = runDurableCheckpoint('expired', 'finalize', input, async assert => {
      await new Promise<void>(resolve => { release = resolve; }); await assert(); return 'old';
    }, { ...options, now: () => time });
    await vi.waitFor(() => expect(release).toBeDefined()); time = 600_000;
    expect(await runDurableCheckpoint('expired', 'finalize', input, async () => 'new', { ...options, now: () => time })).toBe('new');
    release(); await expect(expired).rejects.toThrow('unavailable');
    expect(await runDurableCheckpoint('expired', 'finalize', input, async () => 'wrong', options)).toBe('new');
  });
  it('recovers completion after a lost acknowledgement without overwriting it as unknown', async () => {
    const storage = new MemoryPortfolioStorage(); const write = storage.write.bind(storage); let writes = 0;
    storage.write = async (...args) => { const saved = await write(...args); if (++writes === 2) throw new Error('Lost acknowledgement'); return saved; };
    const work = vi.fn(async () => ({ result: 'saved' }));
    await expect(runDurableCheckpoint('run', 'plan', input, work, { storage })).rejects.toThrow('acknowledgement');
    expect(await runDurableCheckpoint('run', 'plan', input, work, { storage })).toEqual({ result: 'saved' });
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('fails closed on malformed storage or exhausted CAS without running work', async () => {
    const storage = new MemoryPortfolioStorage(); const work = vi.fn(async () => ({}));
    await runDurableCheckpoint('run', 'plan', input, work, { storage }); work.mockClear();
    const key = [...storage.data.keys()][0]; storage.data.set(key, { bytes: Buffer.from('{}'), etag: 'broken' });
    await expect(runDurableCheckpoint('run', 'plan', input, work, { storage })).rejects.toThrow('unavailable');
    storage.write = async () => false;
    await expect(runDurableCheckpoint('new', 'plan', input, work, { storage })).rejects.toThrow('unavailable');
    expect(work).not.toHaveBeenCalled();
  });
});
