import { describe, expect, it } from 'vitest';
import {
  formatLayoutBlueprintForPlanning,
  parseLayoutBlueprint,
  type LayoutBlueprint,
} from '@/lib/layouts/blueprint';

const blueprint = (): LayoutBlueprint => ({
  version: 1,
  composition: {
    flow: 'TEXT_LEFT_VISUAL_RIGHT',
    balance: 'ASYMMETRIC',
    imageTextBalance: 'BALANCED',
  },
  regions: [
    {
      role: 'HEADLINE',
      xPct: 8,
      yPct: 18,
      widthPct: 44,
      heightPct: 26,
      alignment: 'LEFT',
      emphasis: 'PRIMARY',
      crop: 'NONE',
      overlapsOtherRegions: false,
    },
    {
      role: 'HUMAN_PLACEHOLDER',
      xPct: 56,
      yPct: 10,
      widthPct: 42,
      heightPct: 76,
      alignment: 'CENTER',
      emphasis: 'HIGH',
      crop: 'WAIST_UP',
      overlapsOtherRegions: false,
    },
    {
      role: 'CTA',
      xPct: 8,
      yPct: 62,
      widthPct: 28,
      heightPct: 10,
      alignment: 'CENTER',
      emphasis: 'HIGH',
      crop: 'NONE',
      overlapsOtherRegions: false,
    },
  ],
  whitespace: 'MODERATE',
  textDensity: 'SPARSE',
  ctaTreatment: 'ROUNDED_RECTANGLE',
  backgroundMechanisms: ['SOLID_COLOR', 'ASYMMETRIC_COLOR_BLOCK'],
  imageTreatments: ['CUTOUT'],
  typography: {
    headlineScale: 'EXTRA_LARGE',
    headlineWeight: 'BOLD',
    headlineAlignment: 'LEFT',
    hierarchyLevels: 2,
    contrast: 'HIGH',
  },
  spacing: {
    outerMargin: 'GENEROUS',
    regionGap: 'MODERATE',
    alignmentGrid: 'LEFT_EDGE',
  },
  reusableMechanisms: ['ASYMMETRIC_SHAPE_DIVIDER', 'EDGE_ANCHORED_VISUAL'],
  restrictedElementsPresent: {
    humanIdentity: true,
    thirdPartyLogoOrBranding: true,
    exactCopy: true,
    trademark: false,
    claimOrProof: true,
  },
});

describe('LayoutBlueprint validation', () => {
  it('accepts controlled design geometry without carrying third-party content', () => {
    const parsed = parseLayoutBlueprint(blueprint());

    expect(parsed.regions.find((region) => region.role === 'HUMAN_PLACEHOLDER')).toEqual(
      expect.objectContaining({ xPct: 56, yPct: 10, widthPct: 42, heightPct: 76 })
    );
    expect(JSON.stringify(parsed)).not.toContain('personName');
    expect(JSON.stringify(parsed)).not.toContain('headlineText');
    expect(JSON.stringify(parsed)).not.toContain('claimText');
  });

  it('rejects strategy, identity, and copy fields that are outside the contract', () => {
    expect(() =>
      parseLayoutBlueprint({ ...blueprint(), hookOrAngle: 'Copied strategic angle' })
    ).toThrow(/invalid keys/i);

    const withIdentity = blueprint() as unknown as Record<string, unknown>;
    const regions = structuredClone(withIdentity.regions) as Array<Record<string, unknown>>;
    regions[1] = { ...regions[1], identity: 'External spokesperson' };
    withIdentity.regions = regions;
    expect(() => parseLayoutBlueprint(withIdentity)).toThrow(/invalid keys/i);
  });

  it('rejects invalid geometry instead of passing malformed analyzer output downstream', () => {
    const invalid = blueprint() as unknown as Record<string, unknown>;
    const regions = structuredClone(invalid.regions) as Array<Record<string, unknown>>;
    regions[0] = { ...regions[0], xPct: 101 };
    invalid.regions = regions;

    expect(() => parseLayoutBlueprint(invalid)).toThrow(/integer between 0 and 100/i);
  });

  it('tells Sol that human placeholders are geometry only with a non-human fallback', () => {
    const formatted = formatLayoutBlueprintForPlanning(blueprint());

    expect(formatted).toContain('HUMAN_PLACEHOLDER regions only as geometry');
    expect(formatted).toContain('approved TRA human source');
    expect(formatted).toContain('replace human placeholder geometry with a non-human');
    expect(formatted).toContain('Do not reconstruct third-party logos');
  });
});
