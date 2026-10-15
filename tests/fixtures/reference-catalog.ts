import type { ReferencePlanningCandidate } from '@/lib/references/planning';

export const referenceCandidate = (hex = 'a'): ReferencePlanningCandidate => ({
  referenceId: `media_${hex.repeat(32)}`, priority: 'user', angleDescription: 'Explore available options',
  sourceSha256: hex.repeat(64), analyzerModel: 'cached-layout-model',
  blueprint: {
    version: 1, composition: { flow: 'CENTERED_STACK', balance: 'CENTER_WEIGHTED', imageTextBalance: 'TEXT_HEAVY' },
    regions: [{ role: 'HEADLINE', xPct: 10, yPct: 12, widthPct: 80, heightPct: 24, alignment: 'CENTER', emphasis: 'PRIMARY', crop: 'NONE', overlapsOtherRegions: false }],
    whitespace: 'SPARSE', textDensity: 'SPARSE', ctaTreatment: 'PILL', backgroundMechanisms: ['SOLID_COLOR'], imageTreatments: ['NONE'],
    typography: { headlineScale: 'EXTRA_LARGE', headlineWeight: 'BOLD', headlineAlignment: 'CENTER', hierarchyLevels: 2, contrast: 'HIGH' },
    spacing: { outerMargin: 'GENEROUS', regionGap: 'MODERATE', alignmentGrid: 'CENTER_AXIS' }, reusableMechanisms: ['STRONG_SINGLE_COLUMN'],
    restrictedElementsPresent: { humanIdentity: false, thirdPartyLogoOrBranding: true, exactCopy: true, trademark: false, claimOrProof: false },
  },
});
