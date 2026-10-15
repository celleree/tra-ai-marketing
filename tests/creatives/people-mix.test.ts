import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CreativeComposer } from '@/components/creative-generator/creative-composer';
import { peopleMix } from '@/lib/creatives/people-mix';
import { validateGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import { newCreativePortfolio, claimCreativePortfolio, failPortfolioWork, retryPortfolioWork } from '@/lib/creatives/portfolio-job';
import { parseCreativePortfolioJob } from '@/lib/creatives/portfolio-job-parser';
import { parsePortfolioProgress, portfolioProgress } from '@/lib/creatives/portfolio-progress';
import { referenceCandidate } from '../fixtures/reference-catalog';
import { portfolioRequest, portfolioSnapshot } from '../fixtures/creative-portfolio';

describe('ads-with-people admission and persistence', () => {
  it.each([0, 50, 100])('freezes %s percent through reload, claim, failed work and explicit retry', percent => {
    let job = newCreativePortfolio({ ...portfolioRequest(4), peoplePercent: percent });
    const snapshot = portfolioSnapshot(job);
    snapshot.batchPlan.creatives.forEach((item, i) => { if (i < peopleMix(4, percent).withPeople) item.strategy.execution.subjectSource = 'approved-tra-human'; });
    job.snapshot = snapshot; job.planning = { phase: 'READY_TO_RENDER' };
    job = parseCreativePortfolioJob(Buffer.from(JSON.stringify(job)), job.id);
    expect(parsePortfolioProgress(portfolioProgress(job))?.peoplePercent).toBe(percent);
    const claim = claimCreativePortfolio(job, 10, 'lease');
    const failed = failPortfolioWork(claim.job, 'lease', 'Uncertain paid work', 11);
    expect(claimCreativePortfolio(failed, 12).job.slots[0].status).toBe('RETRY_REQUIRED');
    const retried = retryPortfolioWork(failed, 1, 13);
    expect(retried.request.peoplePercent).toBe(percent);
    expect(retried.snapshot).toEqual(snapshot); expect(retried.slots[0].creativeId).toBe(job.slots[0].creativeId);
    retried.snapshot!.batchPlan.creatives[0].strategy.execution.subjectSource = percent === 0 ? 'approved-tra-human' : 'non-human';
    expect(() => parseCreativePortfolioJob(Buffer.from(JSON.stringify(retried)), retried.id)).toThrow('invalid');
  });
  it('preserves omitted fields for historical retransmission and accepts explicit new UI defaults', () => {
    const request = validateGenerateCreativeRequest({ context: 'New', variationCount: 1 });
    expect(request.success && request.data.peoplePercent).toBeUndefined();
    const explicit = validateGenerateCreativeRequest({ context: 'New', variationCount: 1, peoplePercent: 50, useReferenceLibrary: true });
    expect(explicit.success && explicit.data).toMatchObject({ peoplePercent: 50, useReferenceLibrary: true });
    const legacy = newCreativePortfolio(portfolioRequest());
    const before = JSON.stringify(legacy.request);
    expect(parseCreativePortfolioJob(Buffer.from(JSON.stringify(legacy)), legacy.id).request).not.toHaveProperty('peoplePercent');
    expect(JSON.stringify(legacy.request)).toBe(before);
  });
  it.each([-1, 101, 12.5, '50', null])('rejects malformed percent %s', peoplePercent => {
    expect(validateGenerateCreativeRequest({ context: 'New', variationCount: 4, peoplePercent }).success).toBe(false);
  });
  it.each([[4, 50, 2, 2], [5, 50, 3, 2], [1, 0, 0, 1], [1, 50, 1, 0], [4, 100, 4, 0]])('discloses counts and native accessible controls for %s ads at %s percent', (count, percent, withPeople, withoutPeople) => {
    const html = renderToStaticMarkup(createElement(CreativeComposer, { value: '', onChange() {}, onUploadStart() {}, onUploaded() {},
      sourceAssets: [], onSourceRoleChange() {}, onSourceRemoved() {}, variationCount: count, onVariationCountChange() {},
      peoplePercent: percent, onPeoplePercentChange() {}, useReferenceLibrary: true, onReferenceLibraryChange() {}, onSubmit() {}, ready: true, generating: false }));
    expect(html).toContain('Ads with people'); expect(html).toContain(`${withPeople} with people · ${withoutPeople} without people`);
    expect(html).toContain('aria-describedby="creative-people-counts"'); expect(html).toContain(`aria-valuetext="${percent} percent:`);
    expect(html).toContain('min="1"'); expect(html).toContain('min="0" max="100"');
  });
});

it.each([false, true])('freezes reference mode %s through readback and rejects changed mode/unknown library selections', useReferenceLibrary => {
  const job = newCreativePortfolio({ ...portfolioRequest(), peoplePercent: 0, useReferenceLibrary });
  job.snapshot = portfolioSnapshot(job); job.planning = { phase: 'READY_TO_RENDER' };
  if (useReferenceLibrary) {
    const reference = { ...referenceCandidate('7'), priority: 'library' as const };
    job.snapshot.referenceCatalog = [reference];
    job.snapshot.batchPlan.creatives.forEach(concept => { concept.strategy.referenceSelection = { angleSource: null, layoutSource: reference.referenceId, referenceRelationship: 'mixed' }; });
  }
  const loaded = parseCreativePortfolioJob(Buffer.from(JSON.stringify(job)), job.id);
  expect(portfolioProgress(loaded).useReferenceLibrary).toBe(useReferenceLibrary);
  if (useReferenceLibrary) {
    loaded.snapshot!.batchPlan.creatives[0].strategy.referenceSelection!.layoutSource = referenceCandidate('8').referenceId;
    expect(() => parseCreativePortfolioJob(Buffer.from(JSON.stringify(loaded)), loaded.id)).toThrow('invalid');
  }
  expect(validateGenerateCreativeRequest({ context: 'TRA', variationCount: 2, useReferenceLibrary: 'true' }).success).toBe(false);
});
