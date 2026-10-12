import { describe, expect, it } from 'vitest';
import { parseExperimentLearningRecord, selectAcceptedLearningRecords } from '@/lib/learning/records';

const creativeId = `creative_${'a'.repeat(32)}`;
const learning = () => ({ version: 1, id: `learning_${'b'.repeat(32)}`, createdAt: '2026-10-10T12:00:00Z', creativeId,
  identity: { conceptId: creativeId, parentCreativeId: null, operation: 'GENERATE', fingerprint: 'c'.repeat(64) },
  evidenceReferences: ['creative-review:1'], observedOutcome: 'The human reviewer found the caption readable.',
  causalHypothesis: 'Shorter captions may improve readability.', recommendation: 'Test a shorter caption while retaining disclaimers.',
  financialOutcome: 'unknown', review: { status: 'ACCEPTED', reviewerId: 'operator:1', reviewedAt: '2026-10-11T12:00:00Z', notes: 'Useful creative-quality hypothesis; no lift established.' } });
const evidence = [{ reference: 'creative-review:1', status: 'AVAILABLE' }];

describe('offline human-reviewed creative learning', () => {
  it('retains separate observation, unverified hypothesis, recommendation and human metadata', () => {
    expect(parseExperimentLearningRecord(JSON.parse(JSON.stringify(learning())))).toEqual(learning());
    expect(selectAcceptedLearningRecords([learning()], evidence)).toEqual([learning()]);
  });
  it('preserves unknown financial outcome and supports observations without a causal hypothesis', () => {
    expect(parseExperimentLearningRecord({ ...learning(), causalHypothesis: null, review: { status: 'PENDING' } }))
      .toMatchObject({ causalHypothesis: null, financialOutcome: 'unknown', review: { status: 'PENDING' } });
  });
  it.each(['MISSING', 'STALE', 'REJECTED'])('excludes accepted records when evidence is %s', status => {
    expect(selectAcceptedLearningRecords([learning()], [{ ...evidence[0], status }])).toEqual([]);
  });
  it('requires every referenced source, and never promotes pending or rejected reviews', () => {
    expect(selectAcceptedLearningRecords([{ ...learning(), evidenceReferences: ['creative-review:1', 'missing'] }], evidence)).toEqual([]);
    expect(selectAcceptedLearningRecords([{ ...learning(), review: { status: 'PENDING' } }, { ...learning(), review: { ...learning().review, status: 'REJECTED' } }], evidence)).toEqual([]);
    expect(selectAcceptedLearningRecords([learning()], [])).toEqual([]);
  });
  it('holds duplicate learning IDs and ambiguous duplicate evidence instead of adding repeated context', () => {
    expect(selectAcceptedLearningRecords([learning(), learning()], evidence)).toEqual([]);
    expect(selectAcceptedLearningRecords([learning()], [evidence[0], { ...evidence[0], status: 'STALE' }])).toEqual([]);
  });
  it.each([
    ['invalid identity', { ...learning(), identity: {} }],
    ['missing human reviewer', { ...learning(), review: { ...learning().review, reviewerId: '' } }],
    ['review before observation', { ...learning(), review: { ...learning().review, reviewedAt: '2026-10-09T12:00:00Z' } }],
    ['invalid timestamp', { ...learning(), createdAt: '2026-02-30T12:00:00Z' }],
    ['missing evidence', { ...learning(), evidenceReferences: [] }],
    ['empty evidence identity', { ...learning(), evidenceReferences: [''] }],
    ['malformed observation', { ...learning(), observedOutcome: 100 }],
    ['financial claim injection', { ...learning(), financialOutcome: 'revenue-increased' }],
    ['automatic action', { ...learning(), execute: 'rewrite-prompt' }],
    ['accepted without metadata', { ...learning(), review: { status: 'ACCEPTED' } }],
  ])('rejects %s', (_label, value) => expect(parseExperimentLearningRecord(value)).toBeNull());
  it('fails closed on malformed evidence and copies selected records without modifying inputs', () => {
    expect(selectAcceptedLearningRecords([learning()], [{ reference: 'creative-review:1', status: ['AVAILABLE'] }])).toEqual([]);
    expect(selectAcceptedLearningRecords([null], evidence)).toEqual([]);
    const input = learning(); const result = selectAcceptedLearningRecords([input], evidence);
    input.evidenceReferences.push('later'); input.review.notes = 'later';
    expect(result[0].evidenceReferences).toEqual(['creative-review:1']);
    expect(result[0].review).toHaveProperty('notes', 'Useful creative-quality hypothesis; no lift established.');
  });
});
