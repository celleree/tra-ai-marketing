import { afterEach, describe, expect, it, vi } from 'vitest';
const provider = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/ai/provider-telemetry', () => ({ fetchWithProviderUsage: provider.fetch }));
import { analyzeVisualPattern, parseVisualPattern } from '@/lib/discovery/analysis';
const source = { fileName: 'fixture.png', mimeType: 'image/png' as const, buffer: Buffer.from('fixture') };
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('explicit visual inference (fixture model responses)', () => {
  it('stays disabled despite an existing key, without either approval', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture'); vi.stubEnv('DISCOVERY_VISUAL_ANALYSIS_ENABLED', 'false'); vi.stubEnv('DISCOVERY_ANALYSIS_TRANSFER_APPROVED', 'false');
    await expect(analyzeVisualPattern(source)).rejects.toThrow('disabled'); expect(provider.fetch).not.toHaveBeenCalled();
  });
  it('stores controlled model inference with exact image hash, date and model provenance', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture'); vi.stubEnv('DISCOVERY_VISUAL_ANALYSIS_ENABLED', 'true'); vi.stubEnv('DISCOVERY_ANALYSIS_TRANSFER_APPROVED', 'true'); vi.stubEnv('OPENAI_ANALYSIS_MODEL', 'gpt-6-luna');
    provider.fetch.mockResolvedValueOnce(Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ layout: 'TEXT_LEFT_VISUAL_RIGHT', humanPresence: 'present', angle: 'customer-problems', offer: 'free-consultation', spend: 10000 }) }] }] }));
    const result = await analyzeVisualPattern(source); expect(result).toMatchObject({ basis: 'model-inference', model: 'gpt-6-luna', humanPresence: 'present' }); expect(result.imageSha256).toHaveLength(64); expect(result).not.toHaveProperty('spend');
    const body = JSON.parse(provider.fetch.mock.calls[0][3].body); expect(body.store).toBe(false); expect(body.text.format.strict).toBe(true); expect(body.max_output_tokens).toBe(500);
  });
  it('rejects invented layouts, identities or unsupported performance labels', () => {
    expect(() => parseVisualPattern({ layout: 'winning', humanPresence: 'John Smith', angle: 'profitable', offer: 'guaranteed' })).toThrow();
    expect(parseVisualPattern({ layout: 'unknown', humanPresence: 'unknown', angle: 'unknown', offer: 'unknown' }).layout).toBe('unknown');
  });
});
