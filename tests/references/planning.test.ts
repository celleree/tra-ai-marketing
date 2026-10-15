import { describe, expect, it } from 'vitest';
import { parseReferenceCatalog, parseReferenceSelection, resolveReferenceSelection, selectedLayout } from '@/lib/references/planning';
import { referenceCandidate } from '../fixtures/reference-catalog';

const catalog = [referenceCandidate('a'), referenceCandidate('b')];
const [a, b] = catalog.map(item => item.referenceId);
describe('independent reference choices', () => {
  it.each([[a, a, 'matched'], [a, b, 'mixed'], [a, null, 'mixed'], [null, b, 'mixed'], [null, null, 'original']])(
    'resolves %s / %s without forcing source use', (angleSource, layoutSource, relationship) => {
      const selection = resolveReferenceSelection({ angleSource, layoutSource }, catalog);
      expect(selection.referenceRelationship).toBe(relationship);
      expect(parseReferenceSelection(JSON.parse(JSON.stringify(selection)))).toEqual(selection);
      expect(selectedLayout(selection, catalog)).toEqual(layoutSource ? catalog.find(item => item.referenceId === layoutSource)!.blueprint : undefined);
    });
  it('rejects unavailable IDs and contradictory persisted relationships', () => {
    expect(() => resolveReferenceSelection({ angleSource: referenceCandidate('c').referenceId, layoutSource: null }, catalog)).toThrow('Unavailable');
    expect(parseReferenceSelection({ angleSource: a, layoutSource: b, referenceRelationship: 'matched' })).toBeNull();
    expect(() => resolveReferenceSelection({ angleSource: null, layoutSource: false }, catalog)).toThrow();
  });
  it('preserves blueprint/source snapshots and rejects corrupt or duplicate catalog records', () => {
    expect(parseReferenceCatalog(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog);
    expect(parseReferenceCatalog([catalog[0], catalog[0]])).toBeNull();
    expect(parseReferenceCatalog([{ ...catalog[0], blueprint: {} }])).toBeNull();
    expect(parseReferenceCatalog([{ ...catalog[0], sourceSha256: 'changed' }])).toBeNull();
  });
});

describe('optional reusable angle snapshots', () => {
  const reusableAngle = { version: 1, sourceSha256: catalog[0].sourceSha256,
    analyzerModel: 'semantic-model', angleSummary: 'Reduce uncertainty with a clear next step.' };
  it('round trips enrichment separately from historical campaign rationale', () => {
    const enriched = [{ ...catalog[0], reusableAngle }];
    expect(parseReferenceCatalog(JSON.parse(JSON.stringify(enriched)))).toEqual(enriched);
    expect(parseReferenceCatalog(catalog)).toEqual(catalog);
    expect(parseReferenceCatalog(catalog)![0]).not.toHaveProperty('reusableAngle');
  });
  it.each([null, {}, { ...reusableAngle, version: 2 }, { ...reusableAngle, angleSummary: ' ' },
    { ...reusableAngle, angleSummary: 'x'.repeat(2001) }, { ...reusableAngle, analyzerModel: '' },
    { ...reusableAngle, sourceSha256: 'f'.repeat(64) }, { ...reusableAngle, selectionReason: 'campaign' }])(
    'drops malformed enrichment while preserving the saved catalog: %j', value => {
      expect(parseReferenceCatalog([{ ...catalog[0], reusableAngle: value }])).toEqual([catalog[0]]);
    });
});
