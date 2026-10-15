import { describe, expect, it } from 'vitest';
import { parseCreativeStrategy } from '@/lib/creatives/strategy';
import { parseCreativePlanning } from '@/lib/creatives/planning-metadata';
import { approvedHumanSourceId } from '@/lib/video/approved-human';
import { conceptDetails } from '../fixtures/creative-concept-details';

const strategy = () => ({
  category: 'customer-problems', awarenessStage: 'problem-aware', persona: ' Busy taxpayer ',
  painPoint: 'Growing notices', desiredOutcome: 'A clear resolution path', emotion: 'Relief',
  hook: 'Open the letter with confidence', cta: 'Get a consultation', offer: null,
  soWhat: { surfaceMessage: 'We help organize your tax case', functionalConsequence: 'You understand the next step', meaningfulOutcome: 'You can move forward with confidence' },
  execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'photographic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' },
  visualDirection: 'A clean desk and organized documents',
});

describe('CreativeStrategy contract', () => {
  it('persists a stable human choice only with a human execution and keeps old plans unchanged', () => {
    const approvedHumanId = `human_${'a'.repeat(64)}`;
    const human = { ...strategy(), approvedHumanId, execution: { ...strategy().execution, subjectSource: 'approved-tra-human' } };
    const planning = { strategy: human, selectionReason: 'Credible explanation', model: 'gpt-6-astra', reasoningEffort: 'medium' };
    expect(parseCreativePlanning(JSON.parse(JSON.stringify(planning)))?.strategy.approvedHumanId).toBe(approvedHumanId);
    expect(parseCreativeStrategy(human, false)).toBeNull();
    expect(parseCreativeStrategy({ ...strategy(), approvedHumanId }, true)).toBeNull();
    expect(parseCreativeStrategy({ ...human, approvedHumanId: 'unknown' }, true)).toBeNull();
    expect(parseCreativeStrategy(strategy(), false)).not.toHaveProperty('approvedHumanId');
  });
  it('rejects an approved-human strategy containing both legacy and generalized identities', () => {
    const approvedHumanId = `human_${'b'.repeat(64)}`;
    const human = {
      ...strategy(),
      approvedHumanId,
      humanSourceId: approvedHumanSourceId(approvedHumanId),
      execution: { ...strategy().execution, subjectSource: 'approved-tra-human' },
    };
    expect(parseCreativeStrategy(human, true)).toBeNull();
  });

  it('round-trips rich concept details through saved planning without upgrading legacy records', () => {
    const planning = { strategy: { ...strategy(), conceptDetails: { ...conceptDetails, proposition: ' Understand options before committing ' } },
      selectionReason: 'A distinct reason to act', model: 'gpt-6-astra', reasoningEffort: 'medium' };
    expect(parseCreativePlanning(JSON.parse(JSON.stringify(planning)))?.strategy.conceptDetails).toEqual(conceptDetails);
    expect(parseCreativeStrategy(strategy(), false)).not.toHaveProperty('conceptDetails');
    expect(parseCreativeStrategy({ ...strategy(), conceptDetails: { ...conceptDetails, objection: null } }, false)?.conceptDetails?.objection).toBeNull();
  });

  it.each([
    null, { ...conceptDetails, version: 2 }, { ...conceptDetails, proposition: ' ' },
    { ...conceptDetails, subject: 42 }, { ...conceptDetails, environment: 'x'.repeat(1001) },
    { ...conceptDetails, objection: false }, { ...conceptDetails, proofRecordId: 'unverified' },
    { ...conceptDetails, visualMechanism: undefined },
  ])('rejects malformed or unsupported rich details %#', details => {
    expect(parseCreativeStrategy({ ...strategy(), conceptDetails: details }, false)).toBeNull();
  });

  it('retains built-in selection but rejects unknown document sources and preserves legacy plans', () => {
    const withDocument = (taxDocumentReference: string) => ({
      ...strategy(), execution: { ...strategy().execution, taxDocumentReference },
    });
    expect(parseCreativeStrategy(withDocument('irs-notice-v1'), false)?.execution.taxDocumentReference).toBe('irs-notice-v1');
    expect(parseCreativeStrategy(withDocument('uploaded-unknown'), false)).toBeNull();
    expect(parseCreativeStrategy(strategy(), false)?.execution).not.toHaveProperty('taxDocumentReference');
  });
  it('preserves the complete trimmed SO WHAT chain', () => {
    const parsed = parseCreativeStrategy(strategy(), false);
    expect(parsed).toMatchObject({ persona: 'Busy taxpayer', soWhat: strategy().soWhat });
  });

  it.each([
    ['missing outcome chain', () => { const value = strategy(); delete (value.soWhat as Partial<typeof value.soWhat>).meaningfulOutcome; return value; }],
    ['malformed enum', () => ({ ...strategy(), execution: { ...strategy().execution, composition: 'collage' } })],
    ['empty top-level text', () => ({ ...strategy(), persona: '   ' })],
    ['type-invalid top-level text', () => ({ ...strategy(), painPoint: 3 })],
    ['missing top-level text', () => { const value = strategy(); delete (value as Partial<typeof value>).cta; return value; }],
    ['overlong text', () => ({ ...strategy(), hook: 'x'.repeat(1001) })],
    ['unknown key', () => ({ ...strategy(), unexpected: true })],
  ])('rejects %s', (_name, makeValue) => expect(parseCreativeStrategy(makeValue(), false)).toBeNull());

  it('requires a supplied approved source for a human strategy', () => {
    const human = { ...strategy(), execution: { ...strategy().execution, subjectSource: 'approved-tra-human' } };
    expect(parseCreativeStrategy(human, false)).toBeNull();
    expect(parseCreativeStrategy(human, true)?.execution.subjectSource).toBe('approved-tra-human');
  });

  it('accepts non-human strategies with or without an approved source', () => {
    expect(parseCreativeStrategy(strategy(), false)).not.toBeNull();
    expect(parseCreativeStrategy(strategy(), true)).not.toBeNull();
  });
});
