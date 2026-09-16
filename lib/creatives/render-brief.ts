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

const formatSelectedLayoutInstructions = (brief: CreativeRenderBrief) => {
  const blueprint = brief.layoutBlueprint;
  if (!blueprint) return '';
  const imageCopy = 'primaryText' in brief.exactCopy ? null : brief.exactCopy;
  const optionalImageFields = ['shortSupport', 'proofAttribution', 'cta', 'disclosure'] as const;
  const plannedFields = imageCopy
    ? ['headline', ...optionalImageFields.filter(field => Boolean(imageCopy[field]))]
    : ['headline', 'primaryText', 'description', 'cta'];
  const missingOptional = imageCopy ? optionalImageFields.filter(field => !imageCopy[field]) : [];
  const hasCta = Boolean(brief.exactCopy.cta);
  const regions = blueprint.regions.map((region, index) =>
    `${index + 1}. ${region.role}: x=${region.xPct}%, y=${region.yPct}%, width=${region.widthPct}%, height=${region.heightPct}%, alignment=${region.alignment}, emphasis=${region.emphasis}, crop=${region.crop}, overlaps=${region.overlapsOtherRegions}.`
  ).join('\n');
  return `SELECTED LAYOUT BLUEPRINT — AUTHORITATIVE COMPOSITION SCAFFOLD
Priority order: (1) hard compliance/source restrictions, placement safe zones and deterministic logo rules; (2) exactCopy (E2 imageCopy when present); (3) this selected blueprint; (4) generic execution.composition, visualConcept.compositionInstructions and visualDirection.
Preserve all ${blueprint.regions.length} meaningful blueprint regions proportionally for the target canvas, including relative x/y position, width/height, alignment, emphasis/hierarchy and focal-image/subject placement:
${regions}
Preserve composition flow=${blueprint.composition.flow}, balance=${blueprint.composition.balance}, image/text balance=${blueprint.composition.imageTextBalance}, whitespace=${blueprint.whitespace}, text density=${blueprint.textDensity}, spacing outerMargin=${blueprint.spacing.outerMargin}/regionGap=${blueprint.spacing.regionGap}/grid=${blueprint.spacing.alignmentGrid}, and typography headlineScale=${blueprint.typography.headlineScale}/weight=${blueprint.typography.headlineWeight}/alignment=${blueprint.typography.headlineAlignment}/hierarchyLevels=${blueprint.typography.hierarchyLevels}/contrast=${blueprint.typography.contrast}.
Generic composition and visual direction may style or fill content within this scaffold, but must not replace, reorder or materially resize blueprint structure when they conflict. Safe zones may shift or tighten regions only as needed to protect essential content; never treat safe zones as decorative borders.
Planned image text fields: ${plannedFields.join(', ')}. Map only these actually planned fields into appropriate blueprint regions. ${missingOptional.length ? `Absent optional imageCopy fields (${missingOptional.join(', ')}) must stay absent. ` : ''}Do not invent filler copy, badges, trust blocks, benefit rows, cards or extra sections to fill a region; preserve useful whitespace or simplify an empty region while keeping the overall balance.
${hasCta ? `Preserve CTA placement and treatment (${blueprint.ctaTreatment}) where the blueprint provides a CTA region.` : 'No CTA text is planned; do not create a CTA label, button or treatment solely because the blueprint contains one.'}
HUMAN_PLACEHOLDER regions describe geometry only. HUMAN_PLACEHOLDER controls geometry only and never authorizes a person, face or identity; only a separately approved TRA human source can authorize human identity. LOGO_PLACEHOLDER controls reserved geometry only; actual TRA logo handling remains deterministic.
restrictedElementsPresent is warning metadata about the analyzed external Layout Reference, never permission. Never reproduce external people/identity, branding/logos, exact copy, claims, testimonials/proof or trademarks from that reference. Use blueprint data only; raw Layout Reference pixels must not be introduced into final image generation.`;
};

export function formatCreativeRenderBrief(brief: CreativeRenderBrief): string {
  const photographicHuman = brief.execution.subjectSource === 'approved-tra-human'
    && ['photographic', 'documentary'].includes(brief.execution.imageTreatment);
  const copyInstruction = 'primaryText' in brief.exactCopy
    ? 'Use exactCopy verbatim wherever rendered. Respect text density and hierarchy; do not add unplanned filler copy, microprint, badges or checkmarks. Retain required disclaimers exactly; never invent a disclaimer when none is supplied.'
    : 'Use exactCopy verbatim wherever rendered. exactCopy is the complete set of text authorized for the image; do not add Meta body copy, Meta description, filler copy, microprint, badges or checkmarks. Respect the planned text density and hierarchy. Retain an included disclosure exactly; never invent a disclosure when none is supplied.';
  const layoutInstruction = formatSelectedLayoutInstructions(brief);
  return `ONE-AD RENDER BRIEF v${brief.version}
${JSON.stringify(brief, null, 2)}
Execute this planned concept; do not invent another angle, outcome, offer or message.
${copyInstruction}
Planned copy is not advertising approval. Do not add factual claims or treat source pixels as proof.
${layoutInstruction || 'Keep the selected medium, composition and visual direction. Include only the planned subjects and props; do not add decorative objects or extra visual systems.'}
${layoutInstruction ? 'Within the blueprint scaffold, include only the planned subjects and props; do not add decorative objects or extra visual systems.' : ''}
${brief.execution.subjectSource === 'non-human' ? 'This planned concept is explicitly non-human. Do not depict people even when approved TRA source pixels are attached.' : ''}
${photographicHuman ? 'HUMAN PHOTOGRAPHIC REALISM: Preserve the supplied approved TRA identity. Use natural facial proportions, skin texture, eyes, hair, posture, hands, lighting and shadows; avoid plastic skin, beauty retouching, stock-photo stiffness and malformed anatomy.' : ''}`;
}
