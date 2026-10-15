import { describe, expect, it } from 'vitest';
import { assertDraftVideoAssertionCopy, composeDraftVideoAssertion, parseDraftVideoSourceAssertion, projectDraftVideoSourcePassages } from '@/lib/creatives/draft-video-assertion';
import { draftVideoAssertion, draftVideoGuidance, draftVideoPassage } from '../fixtures/draft-video-source';

const adCopy = { primaryText: 'A case described in the supplied video.', headline: 'See the case', description: '' };
const imageCopy = { headline: 'A specific case' };
describe('direct video statements in draft ads', () => {
  it('keeps amounts, outcome, adjacent qualification and source timestamps without a Proof record', () => {
    const passage = draftVideoPassage();
    const composed = composeDraftVideoAssertion({ passageId: passage.passageId, imageField: 'shortSupport' }, [passage], adCopy, imageCopy);
    expect(composed.adCopy.primaryText).toContain('$82,000. The settlement was $1,500. Results depend on individual eligibility; this is not a guaranteed outcome.');
    expect(composed.imageCopy.shortSupport).toBe(passage.exactText);
    expect(composed.draftSourceAssertion).toMatchObject({ startMs: 1000, endMs: 7000, sourceSha256: 'b'.repeat(64),
      verification: 'UNVERIFIED_SOURCE_ASSERTION', permission: 'REQUIRES_REVIEW', contextCoverage: 'BOUNDED' });
    expect(parseDraftVideoSourceAssertion(composed.draftSourceAssertion)).toEqual(composed.draftSourceAssertion);
    expect(() => assertDraftVideoAssertionCopy(composed.draftSourceAssertion, composed)).not.toThrow();
  });
  it('rejects invented passage IDs, altered outcomes, dropped qualifications and self-approved provenance', () => {
    const passage = draftVideoPassage();
    expect(() => composeDraftVideoAssertion({ passageId: 'invented', imageField: 'headline' }, [passage], adCopy, imageCopy)).toThrow('unavailable');
    const assertion = draftVideoAssertion();
    const composed = composeDraftVideoAssertion({ passageId: passage.passageId, imageField: assertion.imageField }, [passage], adCopy, imageCopy);
    for (const shortSupport of [passage.exactText.replace('$1,500', '$0'), 'The settlement was $1,500.']) {
      expect(() => assertDraftVideoAssertionCopy(assertion, { ...composed, imageCopy: { ...composed.imageCopy, shortSupport } })).toThrow('exact video source passage');
    }
    expect(parseDraftVideoSourceAssertion({ ...assertion, verification: 'VERIFIED' })).toBeNull();
    expect(parseDraftVideoSourceAssertion({ ...assertion, permission: 'APPROVED' })).toBeNull();
  });
  it('never clips an oversized source passage to fit the existing copy contract', () => {
    const oversized = structuredClone(draftVideoGuidance) as any;
    oversized.transcriptContext.segments = [{ segmentIndex: 0, startMs: 0, endMs: 1000, text: 'x'.repeat(901) }];
    expect(() => projectDraftVideoSourcePassages(undefined, oversized)).toThrow('exceed the draft copy limit');
  });
  it('retains on-screen qualifications and observation uncertainty with the claim', () => {
    const guidance = structuredClone(draftVideoGuidance) as any;
    guidance.transcriptContext = null;
    guidance.statements = [{ reference: { type: 'VIDEO_ON_SCREEN', frame: { timestampMs: 9000 } }, wording: '$82,000 resolved.',
      context: { type: 'VIDEO_ON_SCREEN', observation: { visibleText: ['$82,000 resolved.', 'One client; results vary.'], uncertainties: ['Small print unclear.'] } } }];
    const [passage] = projectDraftVideoSourcePassages(undefined, guidance);
    expect(passage.exactText).toBe('$82,000 resolved. One client; results vary.');
    expect(passage.uncertainties).toEqual(['Small print unclear.']);
    expect(passage.startMs).toBe(9000);
  });
});
