import { describe, expect, it } from 'vitest';
import { parseVideoCreativeBrief } from '@/lib/video-generation/brief';

const brief = () => ({ version: 1, script: 'Explain the consultation process.', durationSeconds: 10,
  placement: 'VERTICAL_9_16', aspectRatio: '9:16', sources: [],
  shots: [{ durationSeconds: 10, description: 'Non-human scene of organized papers.', subject: 'NON_HUMAN', humanSourceReference: null, sourceReferences: [] }],
  evidenceReferences: ['approved-company:1'], claims: [{ text: 'Consultation available.', evidenceReferences: ['approved-company:1'] }],
  disclaimers: [{ text: 'Results vary.', evidenceReferences: ['approved-company:1'] }],
  voiceSourceReference: null, approval: 'PENDING', provider: null, quotedCost: null });
const humanSource = () => ({ reference: 'tra-human:1', mediaId: `media_${'a'.repeat(32)}`, role: 'TRA_REFERENCE',
  mediaType: 'IMAGE', purpose: 'HUMAN_IDENTITY', permissionReference: null });

describe('provider-neutral offline video brief', () => {
  it('preserves unknown provider/cost and validates non-human scripts/shot plans without source invention', () => {
    expect(parseVideoCreativeBrief(JSON.parse(JSON.stringify(brief())))).toEqual(brief());
  });
  it('requires explicitly typed TRA human source but does not infer animation/likeness permission', () => {
    const input = brief();
    const parsed = parseVideoCreativeBrief({ ...input, sources: [humanSource()], shots: [{ ...input.shots[0], subject: 'SOURCE_HUMAN', humanSourceReference: 'tra-human:1', sourceReferences: ['tra-human:1'] }] });
    expect(parsed?.sources[0].permissionReference).toBeNull();
    expect(parsed?.approval).toBe('PENDING');
  });
  it('allows a separate explicit voice purpose, without assuming portrait images grant voice rights', () => {
    const input = { ...brief(), sources: [{ ...humanSource(), purpose: 'VOICE_IDENTITY', permissionReference: 'caller-permission-record:1' }], voiceSourceReference: 'tra-human:1' };
    expect(parseVideoCreativeBrief(input)?.voiceSourceReference).toBe('tra-human:1');
    expect(parseVideoCreativeBrief({ ...input, sources: [humanSource()] })).toBeNull();
  });
  it.each([
    ['aspect mismatch', { ...brief(), aspectRatio: '1:1' }],
    ['invalid placement', { ...brief(), placement: 'UNSPECIFIED' }],
    ['nonfinite duration', { ...brief(), durationSeconds: Infinity }],
    ['negative duration', { ...brief(), durationSeconds: -1 }],
    ['shot duration mismatch', { ...brief(), shots: [{ ...brief().shots[0], durationSeconds: 5 }] }],
    ['missing shots', { ...brief(), shots: [] }],
    ['missing shot source', { ...brief(), shots: [{ ...brief().shots[0], sourceReferences: ['missing'] }] }],
    ['invented human', { ...brief(), shots: [{ ...brief().shots[0], subject: 'SOURCE_HUMAN', humanSourceReference: 'missing' }] }],
    ['missing claim evidence', { ...brief(), claims: [{ text: 'Claim', evidenceReferences: ['missing'] }] }],
    ['empty disclaimer evidence', { ...brief(), disclaimers: [{ text: 'Disclaimer', evidenceReferences: [] }] }],
    ['guessed provider', { ...brief(), provider: 'guessed-provider' }],
    ['guessed cost', { ...brief(), quotedCost: 1 }],
    ['execution fields', { ...brief(), publish: true }],
    ['malformed approval', { ...brief(), approval: ['APPROVED'] }],
  ])('rejects %s', (_label, value) => expect(parseVideoCreativeBrief(value)).toBeNull());
  it('preserves layout-only purpose and rejects third-party human/content transfer and mismatched media roles', () => {
    const layout = { ...humanSource(), role: 'LAYOUT_REFERENCE', purpose: 'LAYOUT' };
    expect(parseVideoCreativeBrief({ ...brief(), sources: [layout] })?.sources[0].purpose).toBe('LAYOUT');
    expect(parseVideoCreativeBrief({ ...brief(), sources: [{ ...layout, purpose: 'HUMAN_IDENTITY' }] })).toBeNull();
    expect(parseVideoCreativeBrief({ ...brief(), sources: [{ ...layout, purpose: 'CONTENT' }] })).toBeNull();
    expect(parseVideoCreativeBrief({ ...brief(), sources: [{ ...humanSource(), mediaType: 'VIDEO' }] })).toBeNull();
    expect(parseVideoCreativeBrief({ ...brief(), sources: [humanSource(), humanSource()] })).toBeNull();
  });
  it('copies records without turning brief approval into generation admission', () => {
    const input = brief(); const parsed = parseVideoCreativeBrief({ ...input, approval: 'APPROVED' })!;
    input.claims[0].evidenceReferences.push('later');
    expect(parsed.claims[0].evidenceReferences).toEqual(['approved-company:1']);
    expect(parsed).not.toHaveProperty('generationAuthorized');
  });
});
