import { afterEach, expect, it, vi } from 'vitest';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';
import { selectVideoFramesForConcept } from '@/lib/video/concept-selection';

const library = (): VideoFrameLibrary => ({
  version: 1, id: 'library-immutable-id', providerEligible: false, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION',
  sourceVideoMediaId: 'media-video', sourceVideoContentHash: 'a'.repeat(64), durationMs: 2_000,
  analysisModels: { transcription: 'whisper-1', vision: ['vision'] }, transcript: { version: 1, model: 'whisper-1', language: 'en', segments: [] },
  candidates: [], semanticGroups: { sceneTypes: [], topics: [] }, representativeFrames: [
    { id: 'opaque-content-hash-a', candidateIndexes: [0], candidateIndex: 0, timestampMs: 500, frameSha256: 'b'.repeat(64), qualityScore: 9,
      thumbnailDataUrl: 'data:image/jpeg;base64,secret-thumbnail-a', evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION',
      observation: { sceneType: 'PROOF_GRAPHIC', summary: 'A'.repeat(500), composition: 'unused', visibleText: ['B'.repeat(1_100)], topics: ['tax relief'], uncertainties: [] },
      transcriptSegments: [{ segmentIndex: 0, startMs: 0, endMs: 1_000, text: 'C'.repeat(800) }] },
    { id: 'opaque-content-hash-b', candidateIndexes: [1], candidateIndex: 1, timestampMs: 1_500, frameSha256: 'c'.repeat(64), qualityScore: 8,
      thumbnailDataUrl: 'data:image/jpeg;base64,secret-thumbnail-b', evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION',
      observation: { sceneType: 'BRAND_CTA', summary: 'Brand card.', composition: 'unused', visibleText: ['Call now'], topics: ['brand', 'call to action'], uncertainties: [] }, transcriptSegments: [] },
  ],
});
const completed = (frames: unknown) => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ frames }) }] }] });
afterEach(() => vi.unstubAllEnvs());

it('returns provider-selected known IDs in order without mutating the library or granting eligibility', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  const source = library(); const before = JSON.stringify(source);
  const request = vi.fn<typeof fetch>().mockResolvedValue(completed([{ frameId: 'opaque-content-hash-b', reason: 'Clear brand call to action.' }, { frameId: 'opaque-content-hash-a', reason: 'Visible proof graphic.' }]));
  await expect(selectVideoFramesForConcept(source, 'Tax relief proof', { request })).resolves.toEqual({ version: 1, libraryId: source.id,
    sourceVideoMediaId: source.sourceVideoMediaId, sourceVideoContentHash: source.sourceVideoContentHash, concept: 'Tax relief proof',
    providerEligible: false, evidenceStatus: 'UNVERIFIED_MODEL_SELECTION', frames: [{ frameId: 'opaque-content-hash-b', reason: 'Clear brand call to action.' }, { frameId: 'opaque-content-hash-a', reason: 'Visible proof graphic.' }] });
  expect(JSON.stringify(source)).toBe(before);
  const body = JSON.parse(request.mock.calls[0][1]!.body as string); const metadata = body.input[1].content[0].text;
  expect(body).toMatchObject({ model: 'gpt-5.6-terra', store: false, reasoning: { effort: 'low' } });
  expect(body.text.format.schema.properties.frames.items.properties.frameId.enum).toEqual(['opaque-content-hash-a', 'opaque-content-hash-b']);
  expect(metadata).not.toContain('thumbnailDataUrl'); expect(metadata).not.toContain('secret-thumbnail'); expect(metadata).not.toContain('frameSha256');
  expect(JSON.parse(metadata).frames[0]).toMatchObject({ summary: 'A'.repeat(400), visibleText: 'B'.repeat(1_000), temporalTranscriptContext: 'C'.repeat(700) });
});

it.each([
  ['unknown ID', completed([{ frameId: 'other', reason: 'x' }])],
  ['duplicate ID', completed([{ frameId: 'opaque-content-hash-a', reason: 'x' }, { frameId: 'opaque-content-hash-a', reason: 'y' }])],
  ['malformed response', Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{not json' }] }] })],
  ['no selections', completed([])],
  ['refusal', Response.json({ status: 'completed', output: [{ content: [{ type: 'refusal' }] }] })],
  ['incomplete', Response.json({ status: 'incomplete', output: [{ content: [{ type: 'output_text', text: '{"frames":[]}' }] }] })],
  ['provider error', new Response('', { status: 429 })],
])('rejects %s', async (_name, response) => {
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  await expect(selectVideoFramesForConcept(library(), 'Concept', { request: vi.fn<typeof fetch>().mockResolvedValue(response) })).rejects.toThrow();
});

it('rejects missing credentials and invalid briefs before any provider request', async () => {
  const request = vi.fn<typeof fetch>(); vi.stubEnv('OPENAI_API_KEY', '');
  await expect(selectVideoFramesForConcept(library(), 'Concept', { request })).rejects.toThrow('OPENAI_API_KEY');
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  await expect(selectVideoFramesForConcept(library(), ' ', { request })).rejects.toThrow('between 1 and 2000');
  await expect(selectVideoFramesForConcept(library(), 'a'.repeat(2_001), { request })).rejects.toThrow('between 1 and 2000');
  expect(request).not.toHaveBeenCalled();
});
