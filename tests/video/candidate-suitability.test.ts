import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assessCandidateWithCache, isSuitableCandidate, parseCandidateSuitability, readCandidateSuitability,
  type CandidateAssessmentIdentity } from '@/lib/video/candidate-suitability';
import { formatCandidateAssessmentDiagnostic } from '@/lib/video/candidate-assessment-failure';
import { parseProviderSourceOverlayDecision } from '@/lib/video/source-overlay-contract';
import { CANDIDATE_HUMAN_FRAME_SELECTION_POLICY } from '@/lib/video/human-frame-selection';
import type { VideoIntelligenceStorage } from '@/lib/video/intelligence-storage';

const image = Buffer.from('offline-bound-pixels');
const identity: CandidateAssessmentIdentity = { policy: CANDIDATE_HUMAN_FRAME_SELECTION_POLICY, model: 'offline-model',
  sourceVideoMediaId: 'media_' + 'a'.repeat(32), sourceVideoContentHash: 'b'.repeat(64), librarySha256: 'c'.repeat(64),
  representativeFrameId: 'frame-offline', candidateIndex: 0, timestampMs: 1000,
  frameSha256: createHash('sha256').update(image).digest('hex') };
const valid = () => ({ humanPresence: 'CLEAR', facialDetail: 'SUFFICIENT', eyes: 'OPEN_OR_NOT_VISIBLE', blur: 'CLEAR',
  occlusion: 'NONE_OR_MINOR', expressionUsability: 'NATURAL_OR_NEUTRAL', framing: 'USABLE', observableReason: 'Usable portrait.',
  sourceOverlay: { status: 'CLEAN', edge: 'NONE', removePermille: 0, overlayDepthPermille: 0 } });
const completed = (text: string) => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text }] }] });
class MemoryStorage implements VideoIntelligenceStorage {
  values = new Map<string, { bytes: Buffer; etag: string }>(); count = 0;
  async read(key: string) { return this.values.get(key) ?? null; }
  async write(key: string, bytes: Buffer, etag: string | null) {
    const old = this.values.get(key); if (etag === null ? old : old?.etag !== etag) return false;
    this.values.set(key, { bytes, etag: String(++this.count) }); return true;
  }
}
const setup = (response: () => Response | Promise<Response>) => {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
  return { storage: new MemoryStorage(), request, now: () => 1000, deadlineAtMs: 300000 };
};
beforeEach(() => { vi.stubEnv('OPENAI_API_KEY', 'offline-test-only');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Live fetch forbidden'); })); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('source-bound frame assessment failure recovery', () => {
  it.each([
    ['HTTP', () => new Response('PRIVATE_BODY_SECRET', { status: 429 }), { code: 'HTTP', httpStatus: 429 }],
    ['transport', () => { throw new Error('https://private.invalid/?signature=SECRET'); }, { code: 'TRANSPORT' }],
    ['response JSON', () => new Response('PRIVATE_BODY_SECRET'), { code: 'RESPONSE_JSON' }],
    ['incomplete', () => Response.json({ status: 'incomplete', output: [] }), { code: 'RESPONSE_INCOMPLETE' }],
    ['refusal', () => Response.json({ status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'SECRET' }] }] }), { code: 'REFUSAL' }],
    ['missing output', () => Response.json({ status: 'completed', output: {} }), { code: 'OUTPUT_MISSING' }],
    ['output JSON', () => completed('PRIVATE_BODY_SECRET'), { code: 'OUTPUT_JSON' }],
    ['field', () => completed(JSON.stringify({ ...valid(), eyes: 'PRIVATE_BODY_SECRET' })), { code: 'ASSESSMENT_FIELD', field: 'eyes' }],
    ['overlay', () => completed(JSON.stringify({ ...valid(), sourceOverlay: { status: 'CLEAN', edge: 'TOP', removePermille: 200, overlayDepthPermille: 100 } })), { code: 'OVERLAY_INVALID' }],
  ] as const)('retains safe %s diagnostics and never repeats uncertain work on read/resume', async (_label, response, diagnostic) => {
    const dependencies = setup(response);
    const first = await assessCandidateWithCache(identity, image, dependencies);
    expect(first).toMatchObject({ status: 'RETRY_REQUIRED', reason: 'PROVIDER_FAILED', diagnostic });
    expect(await readCandidateSuitability(identity, dependencies)).toEqual(first);
    expect(await assessCandidateWithCache(identity, image, dependencies)).toEqual(first);
    expect(dependencies.request).toHaveBeenCalledOnce();
    const persisted = [...dependencies.storage.values.values()].map(item => item.bytes.toString()).join('');
    expect(persisted).not.toMatch(/SECRET|signature|private.invalid/);
    dependencies.request.mockResolvedValueOnce(completed(JSON.stringify(valid())));
    expect(await assessCandidateWithCache(identity, image, { ...dependencies, retry: true })).toMatchObject({ status: 'COMPLETE' });
    expect(dependencies.request).toHaveBeenCalledTimes(2);
  });

  it('normalizes schema-valid UNSAFE observations without ever making them eligible', async () => {
    const unsafe = { ...valid(), sourceOverlay: { status: 'UNSAFE', edge: 'BOTTOM', removePermille: 200, overlayDepthPermille: 300 } };
    const dependencies = setup(() => completed(JSON.stringify(unsafe)));
    const result = await assessCandidateWithCache(identity, image, dependencies);
    expect(result).toMatchObject({ status: 'COMPLETE', assessment: { sourceOverlay: { version: 2, status: 'UNSAFE' } } });
    expect(isSuitableCandidate(parseCandidateSuitability(unsafe))).toBe(false);
    expect(await assessCandidateWithCache(identity, image, dependencies)).toEqual(result);
    expect(dependencies.request).toHaveBeenCalledOnce();
  });

  it('keeps strict clean/crop gates and accepts canonical historical assessments', () => {
    expect(isSuitableCandidate(parseCandidateSuitability(valid()))).toBe(true);
    for (const sourceOverlay of [
      { status: 'CLEAN', edge: 'TOP', removePermille: 1, overlayDepthPermille: 1 },
      { status: 'EDGE_CROP', edge: 'NONE', removePermille: 200, overlayDepthPermille: 100 },
      { status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 200, overlayDepthPermille: 201 },
      { status: 'UNSAFE', edge: 'BOTTOM', removePermille: 451, overlayDepthPermille: 200 },
    ]) expect(parseProviderSourceOverlayDecision(sourceOverlay)).toBeNull();
    expect(parseProviderSourceOverlayDecision({ status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 200, overlayDepthPermille: 150 }))
      .toEqual({ version: 2, status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 200, overlayDepthPermille: 150 });
    expect(parseCandidateSuitability({ ...valid(), sourceOverlay: { version: 2, status: 'CLEAN' } }).sourceOverlay.status).toBe('CLEAN');
  });

  it('reuses legacy retry records without inventing historical diagnostics or spending', async () => {
    const dependencies = setup(() => { throw new Error('forbidden'); });
    const key = `selections/candidates/sha256/${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}.json`;
    await dependencies.storage.write(key, Buffer.from(JSON.stringify({ version: 1, identity, status: 'RETRY_REQUIRED', reason: 'PROVIDER_FAILED' })), null);
    expect(await assessCandidateWithCache(identity, image, dependencies)).not.toHaveProperty('diagnostic');
    expect(dependencies.request).not.toHaveBeenCalled();
    expect(formatCandidateAssessmentDiagnostic()).toBe('');
    expect(formatCandidateAssessmentDiagnostic({ code: 'ASSESSMENT_FIELD', field: 'eyes' })).toBe(' Assessment diagnostic: ASSESSMENT_FIELD/eyes.');
  });
});
