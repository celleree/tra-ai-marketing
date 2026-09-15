import { buildCreativeCompanyContext, type RuntimeCompanyProfileSnapshot } from '@/lib/company/creative-context';
import type { CreativeImageCopy } from '@/lib/creatives/generated';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';
import type { LayoutBlueprint } from '@/lib/layouts/blueprint';
import type { CreativeConceptDetails, CreativeStrategy } from '@/lib/creatives/strategy';
import { selectedLayout, type ReferencePlanningCandidate } from '@/lib/references/planning';

type LegacyCreativeRenderCopy = {
  headline: string;
  primaryText: string;
  description: string;
  cta: string;
};

/** The renderer executes one plan; company knowledge and batch strategy stay with Astra. */
export type CreativeRenderBrief = {
  version: 1;
  format: PlannedCreativeConcept['format'];
  exactCopy: CreativeImageCopy | LegacyCreativeRenderCopy;
  execution: CreativeStrategy['execution'];
  visualDirection: string;
  visualConcept?: Pick<CreativeConceptDetails, 'visualArchetype' | 'visualMechanism' | 'subject' | 'environment' | 'compositionInstructions'>;
  layoutBlueprint?: LayoutBlueprint;
  brand: { colors: string; typography: string; visualStyle: string };
  compliance: {
    prohibitedClaims: string; claimsRequiringProof: string; requiredDisclaimers: string;
    testimonialsStatisticsRules: string; industryComplianceRules: string;
  };
};

export function buildCreativeRenderBrief(args: {
  concept: Pick<PlannedCreativeConcept, 'format' | 'copy' | 'imageCopy' | 'strategy'>;
  companyProfile?: RuntimeCompanyProfileSnapshot;
  brandColors?: readonly string[];
  brandFontNames?: readonly string[];
  layoutBlueprint?: LayoutBlueprint;
  referenceCatalog?: ReferencePlanningCandidate[];
}): CreativeRenderBrief {
  const company = buildCreativeCompanyContext(args.companyProfile);
  const { strategy, copy, imageCopy, format } = args.concept;
  const execution = strategy.execution;
  const layoutBlueprint = strategy.referenceSelection
    ? selectedLayout(strategy.referenceSelection, args.referenceCatalog ?? []) : args.layoutBlueprint;
  return {
    version: 1, format,
    exactCopy: imageCopy
      ? { ...imageCopy }
      : { headline: copy.headline, primaryText: copy.primaryText, description: copy.description, cta: strategy.cta },
    execution: {
      subjectSource: execution.subjectSource, composition: execution.composition,
      imageTreatment: execution.imageTreatment, textDensity: execution.textDensity,
      ctaTreatment: execution.ctaTreatment, typographyHierarchy: execution.typographyHierarchy,
      ...(execution.taxDocumentReference ? { taxDocumentReference: execution.taxDocumentReference } : {}),
    },
    visualDirection: strategy.visualDirection,
    ...(strategy.conceptDetails ? { visualConcept: {
      visualArchetype: strategy.conceptDetails.visualArchetype, visualMechanism: strategy.conceptDetails.visualMechanism,
      subject: strategy.conceptDetails.subject, environment: strategy.conceptDetails.environment,
      compositionInstructions: strategy.conceptDetails.compositionInstructions,
    } } : {}),
    ...(layoutBlueprint ? { layoutBlueprint } : {}),
    brand: {
      colors: args.brandColors?.length ? args.brandColors.join(', ') : company.brandColors,
      typography: args.brandFontNames?.length ? args.brandFontNames.join('\n') : company.fonts,
      visualStyle: company.visualStyle,
    },
    compliance: {
      prohibitedClaims: company.neverSay, claimsRequiringProof: company.claimsRequiringProof,
      requiredDisclaimers: company.requiredDisclaimers,
      testimonialsStatisticsRules: company.testimonialsStatisticsRules,
      industryComplianceRules: company.industryComplianceRules,
    },
  };
}

export function formatCreativeRenderBrief(brief: CreativeRenderBrief): string {
  const photographicHuman = brief.execution.subjectSource === 'approved-tra-human'
    && ['photographic', 'documentary'].includes(brief.execution.imageTreatment);
  const copyInstruction = 'primaryText' in brief.exactCopy
    ? 'Use exactCopy verbatim wherever rendered. Respect text density and hierarchy; do not add unplanned filler copy, microprint, badges or checkmarks. Retain required disclaimers exactly; never invent a disclaimer when none is supplied.'
    : 'Use exactCopy verbatim wherever rendered. exactCopy is the complete set of text authorized for the image; do not add Meta body copy, Meta description, filler copy, microprint, badges or checkmarks. Respect the planned text density and hierarchy. Retain an included disclosure exactly; never invent a disclosure when none is supplied.';
  return `ONE-AD RENDER BRIEF v${brief.version}
${JSON.stringify(brief, null, 2)}
Execute this planned concept; do not invent another angle, outcome, offer or message.
${copyInstruction}
Planned copy is not advertising approval. Do not add factual claims or treat source pixels as proof.
Keep the selected medium, composition and visual direction. Include only the planned subjects and props; do not add decorative objects or extra visual systems.
${brief.execution.subjectSource === 'non-human' ? 'This planned concept is explicitly non-human. Do not depict people even when approved TRA source pixels are attached.' : ''}
${photographicHuman ? 'HUMAN PHOTOGRAPHIC REALISM: Preserve the supplied approved TRA identity. Use natural facial proportions, skin texture, eyes, hair, posture, hands, lighting and shadows; avoid plastic skin, beauty retouching, stock-photo stiffness and malformed anatomy.' : ''}
${brief.layoutBlueprint ? 'Apply the selected blueprint geometry to this concept and target placement. HUMAN_PLACEHOLDER regions describe geometry only and never authorize an identity.' : ''}`;
}
