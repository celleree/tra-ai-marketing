import { describe, expect, it, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { WanService, type WanDependencies } from '@/lib/video-generation/wan/service';
import { estimateWanCents, maxEstimatedCents, summarizeWanJob, wanAccessEnabled, wanPaidEnabled } from '@/lib/video-generation/wan/types';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
const id = '12345678-1234-1234-1234-123456789abc';
const receipt = { requestId: id, statusUrl: `https://queue.fal.run/fal-ai/wan/requests/${id}/status`, responseUrl: `https://queue.fal.run/fal-ai/wan/requests/${id}` };
class Memory implements VideoIntelligenceStorage {
  data = new Map<string, { bytes: Buffer; etag: string }>(); writes: string[] = [];
  async read(key: string) { return this.data.get(key) ?? null; }
  async write(key: string, bytes: Buffer, etag: string | null) {
    if ((this.data.get(key)?.etag ?? null) !== etag) return false;
    this.data.set(key, { bytes, etag: createHash('sha256').update(bytes).digest('hex') }); this.writes.push(key); return true;
  }
}
function fixture() {
  const storage = new Memory(); let clock = 100_000;
  const deps: WanDependencies = { storage, webhook: vi.fn().mockResolvedValue({ url: 'https://app.example/api/ai-videos/webhook', userId: 'fal-account' }), now: () => clock, access: () => true, paid: () => true, maxCents: () => 500,
    sources: vi.fn().mockResolvedValue({ image: { fileName: 'image.png', buffer: Buffer.from('image'), mediaType: 'IMAGE', mimeType: 'image/png' }, video: { fileName: 'video.mp4', buffer: Buffer.from('video'), mediaType: 'VIDEO', mimeType: 'video/mp4' } }),
    probe: vi.fn().mockResolvedValue({ frames: 32, durationMs: 1333 }), sign: vi.fn().mockResolvedValue('https://private.example/source?signed=secret'),
    provider: { submit: vi.fn().mockResolvedValue(receipt), poll: vi.fn().mockResolvedValue({ state: 'COMPLETED' }), download: vi.fn().mockResolvedValue(Buffer.from('mock-output')) } };
  const service = new WanService(deps);
  const body = { profile: { name: 'Test Character', notes: 'Internal organization only' }, imageId: 'image', videoId: 'video', mode: 'MOVE', resolution: '480p' };
  const quote = () => service.quote('operator-a', body);
  const consent = (quoteId: string) => ({ quoteId, rightsConfirmed: true, providerTransferConfirmed: true, estimatedCostConfirmed: true });
  return { storage, deps, service, body, quote, consent, advance: (ms: number) => { clock += ms; } };
}
afterEach(() => vi.unstubAllEnvs());
describe('Wan quote/admission boundaries', () => {
  it('rounds up sixteen-frame blocks and rejects invalid frame counts', () => {
    expect(estimateWanCents(1, '480p')).toBe(4); expect(estimateWanCents(17, '580p')).toBe(12);
    expect(estimateWanCents(1800, '720p')).toBe(904);
    for (const value of [0, -1, 1801, NaN, 10.5]) expect(() => estimateWanCents(value, '480p')).toThrow();
  });
  it('requires explicit access, paid and key flags and caps configured estimates', () => {
    vi.stubEnv('WAN_ACCESS_ENABLED', 'false'); vi.stubEnv('WAN_PAID_ENABLED', 'true'); vi.stubEnv('FAL_KEY', 'dummy');
    expect(wanAccessEnabled()).toBe(false); expect(wanPaidEnabled()).toBe(false);
    vi.stubEnv('WAN_ACCESS_ENABLED', 'true'); expect(wanPaidEnabled()).toBe(false);
    vi.stubEnv('VERCEL_ENV', 'preview'); vi.stubEnv('VERCEL_URL', 'app.example'); vi.stubEnv('WAN_WEBHOOK_ORIGIN', 'https://app.example'); vi.stubEnv('FAL_WEBHOOK_USER_ID', 'fal-account'); expect(wanPaidEnabled()).toBe(true);
    vi.stubEnv('FAL_KEY', ''); expect(wanPaidEnabled()).toBe(false);
    vi.stubEnv('WAN_MAX_ESTIMATED_USD', '6'); expect(() => maxEstimatedCents()).toThrow();
    vi.stubEnv('WAN_MAX_ESTIMATED_USD', '2.50'); expect(maxEstimatedCents()).toBe(250);
  });
  it('uses decoded frames, immutable quote and hash; never leaks sources or receipt', async () => {
    const f = fixture(); const q = await f.service.quote('operator-a', { ...f.body, durationMs: 1, fps: 1 });
    expect(q.quote.estimatedCents).toBe(8); expect(q.quote.frames).toBe(32);
    const stored = await f.service.get('operator-a', q.id); expect(stored.imageHash).toHaveLength(64);
    const summary = JSON.stringify(summarizeWanJob({ ...stored, receipt }));
    expect(summary).not.toContain('operator-a'); expect(summary).not.toContain('statusUrl'); expect(summary).not.toContain('imageId');
  });
  it('fails closed before sources or provider when access/paid disabled', async () => {
    const f = fixture(); f.deps.access = () => false; await expect(f.quote()).rejects.toThrow('disabled');
    expect(f.deps.sources).not.toHaveBeenCalled(); f.deps.access = () => true;
    const q = await f.quote(); f.deps.paid = () => false;
    await expect(f.service.launch('operator-a', q.id, f.consent(q.quote.id))).rejects.toThrow('disabled'); expect(f.deps.provider.submit).not.toHaveBeenCalled();
  });
  it('blocks excessive estimates and unsupported mode/resolution/profile', async () => {
    const f = fixture(); vi.mocked(f.deps.probe).mockResolvedValue({ frames: 1800, durationMs: 30_000 });
    await expect(f.service.quote('operator-a', { ...f.body, resolution: '720p' })).rejects.toThrow('exceeds');
    for (const patch of [{ mode: 'I2V' }, { resolution: '1080p' }, { profile: { name: '', notes: '' } }]) await expect(f.service.quote('operator-a', { ...f.body, ...patch })).rejects.toThrow('Complete');
  });
  it('rejects missing consent, stale quote and changed source before dispatch', async () => {
    const f = fixture(); const q = await f.quote();
    await expect(f.service.launch('operator-a', q.id, { ...f.consent(q.quote.id), providerTransferConfirmed: false })).rejects.toThrow('Confirm');
    vi.mocked(f.deps.sources).mockResolvedValueOnce({ image: { fileName: 'changed.png', buffer: Buffer.from('changed'), mediaType: 'IMAGE', mimeType: 'image/png' }, video: { fileName: 'video.mp4', buffer: Buffer.from('video'), mediaType: 'VIDEO', mimeType: 'video/mp4' } });
    await expect(f.service.launch('operator-a', q.id, f.consent(q.quote.id))).rejects.toThrow('changed');
    f.advance(600_001); await expect(f.service.launch('operator-a', q.id, f.consent(q.quote.id))).rejects.toThrow('expired');
    expect(f.deps.provider.submit).not.toHaveBeenCalled();
  });
  it('isolates operator jobs, output and listing', async () => {
    const f = fixture(); const q = await f.quote(); expect(await f.service.list('operator-b')).toEqual([]);
    await expect(f.service.launch('operator-b', q.id, f.consent(q.quote.id))).rejects.toThrow('not found');
    await expect(f.service.output('operator-b', q.id)).rejects.toThrow('not found'); expect(f.deps.provider.submit).not.toHaveBeenCalled();
  });
});
describe('Wan durable paid attempt and recovery', () => {
  it('persists SUBMITTING and consent before one paid attempt under racing launches', async () => {
    const f = fixture(); const q = await f.quote();
    vi.mocked(f.deps.provider.submit).mockImplementation(async () => {
      const job = await f.service.get('operator-a', q.id); expect(job.state).toBe('SUBMITTING'); expect(job.consent?.providerTransfer).toBe(true); return receipt;
    });
    await Promise.all([f.service.launch('operator-a', q.id, f.consent(q.quote.id)), f.service.launch('operator-a', q.id, f.consent(q.quote.id))]);
    expect(f.deps.provider.submit).toHaveBeenCalledTimes(1);
    expect((await f.service.get('operator-a', q.id)).receipt).toEqual(receipt);
  });
  it('enforces the hourly limit atomically across concurrent distinct launches', async () => {
    const f = fixture(); const quotes = await Promise.all([f.quote(), f.quote(), f.quote(), f.quote()]);
    const results = await Promise.allSettled(quotes.map(q => f.service.launch('operator-a', q.id, f.consent(q.quote.id))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3);
    expect(f.deps.provider.submit).toHaveBeenCalledTimes(3);
  });
  it('does not let a slow old status overwrite a newer IN_PROGRESS state', async () => {
    const f = fixture(); const q = await f.quote(); await f.service.launch('operator-a', q.id, f.consent(q.quote.id));
    let finish!: (value: { state: 'IN_QUEUE' }) => void; let signal!: () => void;
    const started = new Promise<void>(resolve => { signal = resolve; });
    vi.mocked(f.deps.provider.poll).mockImplementationOnce(() => { signal(); return new Promise(resolve => { finish = resolve; }); }).mockResolvedValueOnce({ state: 'IN_PROGRESS' });
    const slow = f.service.refresh('operator-a', q.id); await started;
    expect((await f.service.refresh('operator-a', q.id)).state).toBe('IN_PROGRESS');
    finish({ state: 'IN_QUEUE' }); await slow;
    expect((await f.service.get('operator-a', q.id)).state).toBe('IN_PROGRESS');
  });
  it('restores an interrupted SUBMITTING job to UNKNOWN without repurchasing', async () => {
    const f = fixture(); const q = await f.quote(); let fail!: (error: Error) => void; let signal!: () => void;
    const started = new Promise<void>(resolve => { signal = resolve; });
    vi.mocked(f.deps.provider.submit).mockImplementationOnce(() => { signal(); return new Promise((_, reject) => { fail = reject; }); });
    const launch = f.service.launch('operator-a', q.id, f.consent(q.quote.id)); await started;
    f.advance(90_002); expect((await f.service.refresh('operator-a', q.id)).state).toBe('UNKNOWN');
    fail(new Error('process interrupted')); await launch;
    await f.service.launch('operator-a', q.id, f.consent(q.quote.id)); expect(f.deps.provider.submit).toHaveBeenCalledTimes(1);
  });
  it('records UNKNOWN on timeout and never resubmits on launch or refresh', async () => {
    const f = fixture(); const q = await f.quote(); vi.mocked(f.deps.provider.submit).mockRejectedValue(new Error('timeout with secret URL'));
    expect((await f.service.launch('operator-a', q.id, f.consent(q.quote.id))).state).toBe('UNKNOWN');
    await f.service.launch('operator-a', q.id, f.consent(q.quote.id)); await f.service.refresh('operator-a', q.id);
    expect(f.deps.provider.submit).toHaveBeenCalledTimes(1); expect(JSON.stringify(await f.service.list('operator-a'))).not.toContain('secret URL');
  });
  it('enforces three attempts/hour across distinct jobs including uncertain attempts', async () => {
    const f = fixture(); vi.mocked(f.deps.provider.submit).mockRejectedValue(new Error('timeout'));
    for (let i = 0; i < 3; i++) { const q = await f.quote(); await f.service.launch('operator-a', q.id, f.consent(q.quote.id)); }
    const q = await f.quote(); await expect(f.service.launch('operator-a', q.id, f.consent(q.quote.id))).rejects.toThrow('3 per hour');
    expect(f.deps.provider.submit).toHaveBeenCalledTimes(3); f.advance(3_600_001);
    const later = await f.quote(); await f.service.launch('operator-a', later.id, f.consent(later.quote.id)); expect(f.deps.provider.submit).toHaveBeenCalledTimes(4);
  });
  it('restores persisted accepted jobs with paid disabled and saves output once under poll races', async () => {
    const f = fixture(); const q = await f.quote(); await f.service.launch('operator-a', q.id, f.consent(q.quote.id));
    f.deps.paid = () => false; const restored = new WanService(f.deps);
    await Promise.all([restored.refresh('operator-a', q.id), restored.refresh('operator-a', q.id)]);
    expect((await restored.list('operator-a'))[0].state).toBe('SUCCEEDED');
    expect(f.storage.writes.filter(key => key.endsWith('output.mp4'))).toHaveLength(1);
    expect((await restored.output('operator-a', q.id)).toString()).toBe('mock-output');
    expect(f.deps.provider.submit).toHaveBeenCalledTimes(1);
  });
  it('reconciles already saved bytes after interrupted job finalization without any provider call', async () => {
    const f = fixture(); const q = await f.quote(); await f.service.launch('operator-a', q.id, f.consent(q.quote.id));
    const ledger = [...f.storage.data.keys()][0]; const key = ledger.replace('/ledger.json', `/jobs/${q.id}/output.mp4`);
    await f.storage.write(key, Buffer.from('recovered'), null); expect((await f.service.refresh('operator-a', q.id)).state).toBe('SUCCEEDED');
    expect(f.deps.provider.poll).not.toHaveBeenCalled(); expect(f.deps.provider.download).not.toHaveBeenCalled();
  });
  it('keeps accepted receipt through expired-output recovery; resumes without purchasing', async () => {
    const f = fixture(); const q = await f.quote(); await f.service.launch('operator-a', q.id, f.consent(q.quote.id));
    vi.mocked(f.deps.provider.download).mockRejectedValueOnce(new Error('403 expired bearer'));
    expect((await f.service.refresh('operator-a', q.id)).state).toBe('RECOVERY');
    expect((await f.service.get('operator-a', q.id)).receipt).toEqual(receipt);
    expect((await f.service.refresh('operator-a', q.id)).state).toBe('SUCCEEDED'); expect(f.deps.provider.submit).toHaveBeenCalledTimes(1);
  });
  it('marks provider errors FAILED and never downloads or repurchases', async () => {
    const f = fixture(); const q = await f.quote(); await f.service.launch('operator-a', q.id, f.consent(q.quote.id));
    vi.mocked(f.deps.provider.poll).mockResolvedValue({ state: 'FAILED' }); expect((await f.service.refresh('operator-a', q.id)).state).toBe('FAILED');
    await f.service.refresh('operator-a', q.id); expect(f.deps.provider.download).not.toHaveBeenCalled(); expect(f.deps.provider.submit).toHaveBeenCalledTimes(1);
  });
});

it('captures unattended completion without browser polling and remains available after provider expiry', async () => {
  const f = fixture(), q = await f.quote(); await f.service.launch('operator-a', q.id, f.consent(q.quote.id));
  const owner = createHash('sha256').update('operator-a').digest('hex'); f.deps.access = () => false; f.deps.paid = () => false;
  await f.service.completeWebhook(owner, q.id, receipt.requestId, 'fal-account', 'OK');
  f.advance(2 * 3600000); vi.mocked(f.deps.provider.download).mockRejectedValue(new Error('provider permanently deleted'));
  f.deps.access = () => true; expect((await f.service.list('operator-a'))[0].state).toBe('SUCCEEDED'); expect((await f.service.output('operator-a', q.id)).toString()).toBe('mock-output');
  await f.service.completeWebhook(owner, q.id, receipt.requestId, 'fal-account', 'OK'); expect(f.deps.provider.submit).toHaveBeenCalledTimes(1); expect(f.deps.provider.download).toHaveBeenCalledTimes(1);
});
it('does not acknowledge a transient capture failure and accepts delivery retry without a new purchase', async () => {
  const f = fixture(), q = await f.quote(); await f.service.launch('operator-a', q.id, f.consent(q.quote.id));
  const owner = createHash('sha256').update('operator-a').digest('hex'); vi.mocked(f.deps.provider.download).mockRejectedValueOnce(new Error('temporary storage/network failure'));
  await expect(f.service.completeWebhook(owner, q.id, receipt.requestId, 'fal-account', 'OK')).rejects.toMatchObject({ status: 503 });
  await f.service.completeWebhook(owner, q.id, receipt.requestId, 'fal-account', 'OK'); expect((await f.service.get('operator-a', q.id)).state).toBe('SUCCEEDED'); expect(f.deps.provider.submit).toHaveBeenCalledTimes(1);
});
it('handles completion before submit acknowledgment without regressing the saved output', async () => {
  const f = fixture(), q = await f.quote(), owner = createHash('sha256').update('operator-a').digest('hex');
  vi.mocked(f.deps.provider.submit).mockImplementationOnce(async () => { await f.service.completeWebhook(owner, q.id, receipt.requestId, 'fal-account', 'OK'); return receipt; });
  expect((await f.service.launch('operator-a', q.id, f.consent(q.quote.id))).state).toBe('SUCCEEDED'); expect(f.deps.provider.submit).toHaveBeenCalledTimes(1);
});
it('rejects wrong account/request/job and stops before paid submission when callback readiness fails', async () => {
  const f = fixture(), q = await f.quote(), owner = createHash('sha256').update('operator-a').digest('hex');
  vi.mocked(f.deps.webhook).mockRejectedValueOnce(new Error('protected callback'));
  await expect(f.service.launch('operator-a', q.id, f.consent(q.quote.id))).rejects.toThrow(); expect(f.deps.provider.submit).not.toHaveBeenCalled(); expect((await f.service.get('operator-a', q.id)).state).toBe('QUOTED');
  await f.service.launch('operator-a', q.id, f.consent(q.quote.id));
  await expect(f.service.completeWebhook(owner, q.id, receipt.requestId, 'wrong-account', 'OK')).rejects.toMatchObject({ status: 403 });
  await expect(f.service.completeWebhook(owner, q.id, '00000000-0000-0000-0000-000000000000', 'fal-account', 'OK')).rejects.toMatchObject({ status: 403 });
  expect(f.deps.provider.download).not.toHaveBeenCalled();
});

it('persists signed provider failure without downloading or purchasing a replacement', async () => {
  const f = fixture(), q = await f.quote(), owner = createHash('sha256').update('operator-a').digest('hex');
  vi.mocked(f.deps.provider.submit).mockImplementationOnce(async () => { await f.service.completeWebhook(owner, q.id, receipt.requestId, 'fal-account', 'ERROR'); return receipt; });
  expect((await f.service.launch('operator-a', q.id, f.consent(q.quote.id))).state).toBe('FAILED');
  await f.service.completeWebhook(owner, q.id, receipt.requestId, 'fal-account', 'ERROR');
  expect(f.deps.provider.submit).toHaveBeenCalledTimes(1); expect(f.deps.provider.download).not.toHaveBeenCalled();
});
