export const LAYOUT_BLUEPRINT_SCHEMA_VERSION = 1 as const;

export const LAYOUT_REGION_ROLES = [
  'HEADLINE',
  'SUPPORTING_TEXT',
  'CTA',
  'HUMAN_PLACEHOLDER',
  'NON_HUMAN_VISUAL',
  'CARD_OVERLAY',
  'LOGO_PLACEHOLDER',
  'DECORATIVE',
] as const;

export const LAYOUT_ALIGNMENTS = ['LEFT', 'CENTER', 'RIGHT', 'NONE'] as const;
export const LAYOUT_EMPHASIS_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'PRIMARY'] as const;
export const LAYOUT_CROPS = [
  'NONE',
  'HEADSHOT',
  'CHEST_UP',
  'WAIST_UP',
  'THREE_QUARTER',
  'FULL_BODY',
  'OBJECT_CLOSEUP',
  'OBJECT_FULL',
] as const;
export const LAYOUT_FLOWS = [
  'TEXT_LEFT_VISUAL_RIGHT',
  'VISUAL_LEFT_TEXT_RIGHT',
  'STACKED_TEXT_OVER_VISUAL',
  'STACKED_VISUAL_OVER_TEXT',
  'CENTERED_STACK',
  'HORIZONTAL_SPLIT',
  'VERTICAL_SPLIT',
  'FULL_BLEED_WITH_OVERLAY',
  'GRID',
  'OTHER',
] as const;
export const LAYOUT_BALANCES = [
  'SYMMETRIC',
  'ASYMMETRIC',
  'CENTER_WEIGHTED',
  'EDGE_WEIGHTED',
] as const;
export const IMAGE_TEXT_BALANCES = [
  'MOSTLY_TEXT',
  'TEXT_HEAVY',
  'BALANCED',
  'VISUAL_HEAVY',
  'MOSTLY_VISUAL',
] as const;
export const DENSITY_LEVELS = ['SPARSE', 'MODERATE', 'DENSE'] as const;
export const SPACING_LEVELS = ['TIGHT', 'MODERATE', 'GENEROUS'] as const;
export const CTA_TREATMENTS = [
  'NONE',
  'SOLID_RECTANGLE',
  'ROUNDED_RECTANGLE',
  'PILL',
  'OUTLINE',
  'TEXT_ONLY',
] as const;
export const BACKGROUND_MECHANISMS = [
  'SOLID_COLOR',
  'GRADIENT',
  'GEOMETRIC_SHAPE',
  'ASYMMETRIC_COLOR_BLOCK',
  'PHOTO_FULL_BLEED',
  'PHOTO_PANEL',
  'TEXTURE',
  'DIVIDER',
  'CARD_SURFACE',
  'NONE',
] as const;
export const IMAGE_TREATMENTS = [
  'NONE',
  'CUTOUT',
  'FULL_BLEED_PHOTO',
  'FRAMED_PHOTO',
  'ROUNDED_MASK',
  'ILLUSTRATION',
  'ICON',
  'MONOCHROME',
  'DUOTONE',
  'DROP_SHADOW',
] as const;
export const FONT_WEIGHTS = ['REGULAR', 'MEDIUM', 'SEMIBOLD', 'BOLD', 'EXTRABOLD'] as const;
export const TYPE_SCALES = ['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE'] as const;
export const CONTRAST_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const ALIGNMENT_GRIDS = [
  'LEFT_EDGE',
  'CENTER_AXIS',
  'RIGHT_EDGE',
  'MIXED_GRID',
] as const;
export const REUSABLE_LAYOUT_MECHANISMS = [
  'ASYMMETRIC_SHAPE_DIVIDER',
  'CARD_OVERLAP',
  'CTA_OVERLAP',
  'FLOATING_CARD',
  'VISUAL_CUTOUT',
  'SAFE_BRAND_CORNER',
  'EDGE_ANCHORED_VISUAL',
  'CENTERED_FOCAL_OBJECT',
  'LAYERED_DEPTH',
  'STRONG_SINGLE_COLUMN',
  'TWO_COLUMN_SPLIT',
  'NONE',
] as const;

export type LayoutRegionRole = (typeof LAYOUT_REGION_ROLES)[number];
export type LayoutAlignment = (typeof LAYOUT_ALIGNMENTS)[number];
export type LayoutEmphasis = (typeof LAYOUT_EMPHASIS_LEVELS)[number];
export type LayoutCrop = (typeof LAYOUT_CROPS)[number];
export type LayoutFlow = (typeof LAYOUT_FLOWS)[number];
export type LayoutBalance = (typeof LAYOUT_BALANCES)[number];
export type ImageTextBalance = (typeof IMAGE_TEXT_BALANCES)[number];
export type DensityLevel = (typeof DENSITY_LEVELS)[number];
export type SpacingLevel = (typeof SPACING_LEVELS)[number];
export type CtaTreatment = (typeof CTA_TREATMENTS)[number];
export type BackgroundMechanism = (typeof BACKGROUND_MECHANISMS)[number];
export type ImageTreatment = (typeof IMAGE_TREATMENTS)[number];
export type FontWeight = (typeof FONT_WEIGHTS)[number];
export type TypeScale = (typeof TYPE_SCALES)[number];
export type ContrastLevel = (typeof CONTRAST_LEVELS)[number];
export type AlignmentGrid = (typeof ALIGNMENT_GRIDS)[number];
export type ReusableLayoutMechanism = (typeof REUSABLE_LAYOUT_MECHANISMS)[number];

export interface LayoutRegion {
  role: LayoutRegionRole;
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  alignment: LayoutAlignment;
  emphasis: LayoutEmphasis;
  crop: LayoutCrop;
  overlapsOtherRegions: boolean;
}

export interface LayoutBlueprint {
  version: typeof LAYOUT_BLUEPRINT_SCHEMA_VERSION;
  composition: {
    flow: LayoutFlow;
    balance: LayoutBalance;
    imageTextBalance: ImageTextBalance;
  };
  regions: LayoutRegion[];
  whitespace: DensityLevel;
  textDensity: DensityLevel;
  ctaTreatment: CtaTreatment;
  backgroundMechanisms: BackgroundMechanism[];
  imageTreatments: ImageTreatment[];
  typography: {
    headlineScale: TypeScale;
    headlineWeight: FontWeight;
    headlineAlignment: LayoutAlignment;
    hierarchyLevels: number;
    contrast: ContrastLevel;
  };
  spacing: {
    outerMargin: SpacingLevel;
    regionGap: SpacingLevel;
    alignmentGrid: AlignmentGrid;
  };
  reusableMechanisms: ReusableLayoutMechanism[];
  restrictedElementsPresent: {
    humanIdentity: boolean;
    thirdPartyLogoOrBranding: boolean;
    exactCopy: boolean;
    trademark: boolean;
    claimOrProof: boolean;
  };
}

export class LayoutBlueprintValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutBlueprintValidationError';
  }
}

const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LayoutBlueprintValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const assertExactKeys = (
  object: Record<string, unknown>,
  keys: readonly string[],
  label: string
) => {
  const allowed = new Set(keys);
  const actual = Object.keys(object);
  const extra = actual.filter((key) => !allowed.has(key));
  const missing = keys.filter((key) => !(key in object));
  if (extra.length || missing.length) {
    throw new LayoutBlueprintValidationError(
      `${label} has invalid keys.${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}${extra.length ? ` Extra: ${extra.join(', ')}.` : ''}`
    );
  }
};

const enumValue = <T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number] => {
  if (typeof value !== 'string' || !values.includes(value as T[number])) {
    throw new LayoutBlueprintValidationError(`${label} is invalid.`);
  }
  return value as T[number];
};

const booleanValue = (value: unknown, label: string) => {
  if (typeof value !== 'boolean') {
    throw new LayoutBlueprintValidationError(`${label} must be a boolean.`);
  }
  return value;
};

const integerInRange = (
  value: unknown,
  min: number,
  max: number,
  label: string
) => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new LayoutBlueprintValidationError(
      `${label} must be an integer between ${min} and ${max}.`
    );
  }
  return value as number;
};

const enumArray = <T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
  maxItems: number
): T[number][] => {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new LayoutBlueprintValidationError(`${label} must be an array with at most ${maxItems} items.`);
  }
  const parsed = value.map((item, index) =>
    enumValue(item, values, `${label}[${index}]`)
  );
  return [...new Set(parsed)];
};

const parseRegion = (value: unknown, index: number): LayoutRegion => {
  const label = `regions[${index}]`;
  const region = asObject(value, label);
  assertExactKeys(
    region,
    [
      'role',
      'xPct',
      'yPct',
      'widthPct',
      'heightPct',
      'alignment',
      'emphasis',
      'crop',
      'overlapsOtherRegions',
    ],
    label
  );

  return {
    role: enumValue(region.role, LAYOUT_REGION_ROLES, `${label}.role`),
    xPct: integerInRange(region.xPct, 0, 100, `${label}.xPct`),
    yPct: integerInRange(region.yPct, 0, 100, `${label}.yPct`),
    widthPct: integerInRange(region.widthPct, 1, 100, `${label}.widthPct`),
    heightPct: integerInRange(region.heightPct, 1, 100, `${label}.heightPct`),
    alignment: enumValue(region.alignment, LAYOUT_ALIGNMENTS, `${label}.alignment`),
    emphasis: enumValue(region.emphasis, LAYOUT_EMPHASIS_LEVELS, `${label}.emphasis`),
    crop: enumValue(region.crop, LAYOUT_CROPS, `${label}.crop`),
    overlapsOtherRegions: booleanValue(
      region.overlapsOtherRegions,
      `${label}.overlapsOtherRegions`
    ),
  };
};

export function parseLayoutBlueprint(input: unknown): LayoutBlueprint {
  const root = asObject(input, 'LayoutBlueprint');
  assertExactKeys(
    root,
    [
      'version',
      'composition',
      'regions',
      'whitespace',
      'textDensity',
      'ctaTreatment',
      'backgroundMechanisms',
      'imageTreatments',
      'typography',
      'spacing',
      'reusableMechanisms',
      'restrictedElementsPresent',
    ],
    'LayoutBlueprint'
  );

  if (root.version !== LAYOUT_BLUEPRINT_SCHEMA_VERSION) {
    throw new LayoutBlueprintValidationError('LayoutBlueprint.version is invalid.');
  }

  const composition = asObject(root.composition, 'composition');
  assertExactKeys(composition, ['flow', 'balance', 'imageTextBalance'], 'composition');

  const regionsRaw = root.regions;
  if (!Array.isArray(regionsRaw) || regionsRaw.length < 1 || regionsRaw.length > 20) {
    throw new LayoutBlueprintValidationError('regions must contain between 1 and 20 items.');
  }

  const typography = asObject(root.typography, 'typography');
  assertExactKeys(
    typography,
    ['headlineScale', 'headlineWeight', 'headlineAlignment', 'hierarchyLevels', 'contrast'],
    'typography'
  );

  const spacing = asObject(root.spacing, 'spacing');
  assertExactKeys(spacing, ['outerMargin', 'regionGap', 'alignmentGrid'], 'spacing');

  const restricted = asObject(root.restrictedElementsPresent, 'restrictedElementsPresent');
  assertExactKeys(
    restricted,
    ['humanIdentity', 'thirdPartyLogoOrBranding', 'exactCopy', 'trademark', 'claimOrProof'],
    'restrictedElementsPresent'
  );

  return {
    version: LAYOUT_BLUEPRINT_SCHEMA_VERSION,
    composition: {
      flow: enumValue(composition.flow, LAYOUT_FLOWS, 'composition.flow'),
      balance: enumValue(composition.balance, LAYOUT_BALANCES, 'composition.balance'),
      imageTextBalance: enumValue(
        composition.imageTextBalance,
        IMAGE_TEXT_BALANCES,
        'composition.imageTextBalance'
      ),
    },
    regions: regionsRaw.map(parseRegion),
    whitespace: enumValue(root.whitespace, DENSITY_LEVELS, 'whitespace'),
    textDensity: enumValue(root.textDensity, DENSITY_LEVELS, 'textDensity'),
    ctaTreatment: enumValue(root.ctaTreatment, CTA_TREATMENTS, 'ctaTreatment'),
    backgroundMechanisms: enumArray(
      root.backgroundMechanisms,
      BACKGROUND_MECHANISMS,
      'backgroundMechanisms',
      6
    ),
    imageTreatments: enumArray(root.imageTreatments, IMAGE_TREATMENTS, 'imageTreatments', 6),
    typography: {
      headlineScale: enumValue(typography.headlineScale, TYPE_SCALES, 'typography.headlineScale'),
      headlineWeight: enumValue(
        typography.headlineWeight,
        FONT_WEIGHTS,
        'typography.headlineWeight'
      ),
      headlineAlignment: enumValue(
        typography.headlineAlignment,
        LAYOUT_ALIGNMENTS,
        'typography.headlineAlignment'
      ),
      hierarchyLevels: integerInRange(
        typography.hierarchyLevels,
        1,
        5,
        'typography.hierarchyLevels'
      ),
      contrast: enumValue(typography.contrast, CONTRAST_LEVELS, 'typography.contrast'),
    },
    spacing: {
      outerMargin: enumValue(spacing.outerMargin, SPACING_LEVELS, 'spacing.outerMargin'),
      regionGap: enumValue(spacing.regionGap, SPACING_LEVELS, 'spacing.regionGap'),
      alignmentGrid: enumValue(spacing.alignmentGrid, ALIGNMENT_GRIDS, 'spacing.alignmentGrid'),
    },
    reusableMechanisms: enumArray(
      root.reusableMechanisms,
      REUSABLE_LAYOUT_MECHANISMS,
      'reusableMechanisms',
      8
    ),
    restrictedElementsPresent: {
      humanIdentity: booleanValue(restricted.humanIdentity, 'restrictedElementsPresent.humanIdentity'),
      thirdPartyLogoOrBranding: booleanValue(
        restricted.thirdPartyLogoOrBranding,
        'restrictedElementsPresent.thirdPartyLogoOrBranding'
      ),
      exactCopy: booleanValue(restricted.exactCopy, 'restrictedElementsPresent.exactCopy'),
      trademark: booleanValue(restricted.trademark, 'restrictedElementsPresent.trademark'),
      claimOrProof: booleanValue(restricted.claimOrProof, 'restrictedElementsPresent.claimOrProof'),
    },
  };
}

const schemaEnum = (values: readonly string[]) => ({ type: 'string', enum: [...values] });
const percentage = { type: 'integer', minimum: 0, maximum: 100 };

export const LAYOUT_BLUEPRINT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    version: { type: 'integer', enum: [LAYOUT_BLUEPRINT_SCHEMA_VERSION] },
    composition: {
      type: 'object',
      properties: {
        flow: schemaEnum(LAYOUT_FLOWS),
        balance: schemaEnum(LAYOUT_BALANCES),
        imageTextBalance: schemaEnum(IMAGE_TEXT_BALANCES),
      },
      required: ['flow', 'balance', 'imageTextBalance'],
      additionalProperties: false,
    },
    regions: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          role: schemaEnum(LAYOUT_REGION_ROLES),
          xPct: percentage,
          yPct: percentage,
          widthPct: { type: 'integer', minimum: 1, maximum: 100 },
          heightPct: { type: 'integer', minimum: 1, maximum: 100 },
          alignment: schemaEnum(LAYOUT_ALIGNMENTS),
          emphasis: schemaEnum(LAYOUT_EMPHASIS_LEVELS),
          crop: schemaEnum(LAYOUT_CROPS),
          overlapsOtherRegions: { type: 'boolean' },
        },
        required: [
          'role',
          'xPct',
          'yPct',
          'widthPct',
          'heightPct',
          'alignment',
          'emphasis',
          'crop',
          'overlapsOtherRegions',
        ],
        additionalProperties: false,
      },
    },
    whitespace: schemaEnum(DENSITY_LEVELS),
    textDensity: schemaEnum(DENSITY_LEVELS),
    ctaTreatment: schemaEnum(CTA_TREATMENTS),
    backgroundMechanisms: {
      type: 'array',
      maxItems: 6,
      items: schemaEnum(BACKGROUND_MECHANISMS),
    },
    imageTreatments: {
      type: 'array',
      maxItems: 6,
      items: schemaEnum(IMAGE_TREATMENTS),
    },
    typography: {
      type: 'object',
      properties: {
        headlineScale: schemaEnum(TYPE_SCALES),
        headlineWeight: schemaEnum(FONT_WEIGHTS),
        headlineAlignment: schemaEnum(LAYOUT_ALIGNMENTS),
        hierarchyLevels: { type: 'integer', minimum: 1, maximum: 5 },
        contrast: schemaEnum(CONTRAST_LEVELS),
      },
      required: [
        'headlineScale',
        'headlineWeight',
        'headlineAlignment',
        'hierarchyLevels',
        'contrast',
      ],
      additionalProperties: false,
    },
    spacing: {
      type: 'object',
      properties: {
        outerMargin: schemaEnum(SPACING_LEVELS),
        regionGap: schemaEnum(SPACING_LEVELS),
        alignmentGrid: schemaEnum(ALIGNMENT_GRIDS),
      },
      required: ['outerMargin', 'regionGap', 'alignmentGrid'],
      additionalProperties: false,
    },
    reusableMechanisms: {
      type: 'array',
      maxItems: 8,
      items: schemaEnum(REUSABLE_LAYOUT_MECHANISMS),
    },
    restrictedElementsPresent: {
      type: 'object',
      properties: {
        humanIdentity: { type: 'boolean' },
        thirdPartyLogoOrBranding: { type: 'boolean' },
        exactCopy: { type: 'boolean' },
        trademark: { type: 'boolean' },
        claimOrProof: { type: 'boolean' },
      },
      required: [
        'humanIdentity',
        'thirdPartyLogoOrBranding',
        'exactCopy',
        'trademark',
        'claimOrProof',
      ],
      additionalProperties: false,
    },
  },
  required: [
    'version',
    'composition',
    'regions',
    'whitespace',
    'textDensity',
    'ctaTreatment',
    'backgroundMechanisms',
    'imageTreatments',
    'typography',
    'spacing',
    'reusableMechanisms',
    'restrictedElementsPresent',
  ],
  additionalProperties: false,
} as const;

export const formatLayoutBlueprintForPlanning = (blueprint: LayoutBlueprint) =>
  `STRUCTURED LAYOUT BLUEPRINT (design mechanism only; never a source of copy, claims, brand identity, trademark identity, or person identity):\n${JSON.stringify(
    blueprint,
    null,
    2
  )}\n\nLAYOUT ADAPTATION RULES:\n- Treat HUMAN_PLACEHOLDER regions only as geometry. They do not authorize a person or identity.\n- Use a human only when an approved TRA human source is actually attached at the final image-provider boundary. Otherwise replace human placeholder geometry with a non-human TRA-appropriate visual.\n- Do not reconstruct third-party logos, branding, trademarks, exact wording, testimonial/proof content, statistics, or claims from the reference.\n- Preserve useful composition, hierarchy, spacing, image/text balance, CTA geometry, and visual mechanisms while adapting them to approved TRA company context.`;
