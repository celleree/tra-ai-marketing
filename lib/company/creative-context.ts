import {
  BRAND_GUIDELINE_FIELDS,
  DEFAULT_COMPANY_PROFILE,
  GUARDRAIL_FIELDS,
  KNOWLEDGE_BASE_FIELDS,
  type CompanyFields,
  type CompanyProfile,
} from '@/lib/company/profile';

export const COMPANY_PROFILE_STORAGE_KEY = 'tra-company-profile-v2';

export type RuntimeCompanyProfileSnapshot = Partial<{
  websiteUrl: string;
  knowledgeBase: CompanyFields;
  brandGuidelines: CompanyFields;
  guardrails: CompanyFields;
}>;

export type CreativeCompanyContext = {
  companySummary: string;
  servicesOffers: string;
  targetCustomers: string;
  customerProblems: string;
  desiredOutcomes: string;
  differentiators: string;
  proof: string;
  faqsFacts: string;
  brandColors: string;
  fonts: string;
  voiceTone: string;
  visualStyle: string;
  copyStyle: string;
  neverSay: string;
  approvedClaims: string;
  claimsRequiringProof: string;
  requiredDisclaimers: string;
  testimonialsStatisticsRules: string;
  industryComplianceRules: string;
  customerInsights: string;
};

const MAX_FIELD_LENGTH = 12000;
const MAX_URL_LENGTH = 2048;

const approvedBaseline: Partial<CompanyProfile> = {
  knowledgeBase: {
    servicesOffers: [
      'Free/no-cost tax-debt consultation.',
      'Review of tax hardship and IRS communications.',
      'Assessment of eligibility for IRS debt-forgiveness programs, including the IRS Fresh Start Program.',
      'Representation notification to tax authorities.',
      'Research and comparison of available debt-forgiveness programs.',
      'Negotiation with the IRS and state taxing authorities.',
      'Assistance with tax audits, wage garnishments, bank levies, tax-liability negotiation, and tax-debt resolution.',
    ].join('\n'),
    differentiators: [
      "TRA's stated process is Consultation, Research, Resolution.",
      'TRA says it works directly with the IRS and develops a personalized strategy.',
      'TRA says its team includes tax-relief experts, attorneys, and specialized licensed tax-resolution professionals.',
    ].join('\n'),
    faqsFacts: [
      'TRA says a consultation is free/no-cost.',
      'Services may not be available in all states.',
      'Fees may vary by state.',
      'Address: 16808 Armstrong Ave., Irvine, CA 92606.',
      'Phone: 800-501-4249 / 800-575-2063.',
      'Email: contact@tra.com.',
    ].join('\n'),
  },
  brandGuidelines: {
    brandColors: '#0577BF\n#6D6E71\n#FFFFFF\n#333333',
    visualStyle: [
      'Professionally art-directed, restrained, and intentional.',
      'Favor one clear focal idea, strong hierarchy, deliberate whitespace, and clean image-to-text balance over information density.',
      'Do not automatically add benefit sections, icons, trust badges, floating cards, extra text boxes, CTA bars, proof blocks, or decorative elements.',
      'If the reference is visually simple, keep the TRA adaptation visually simple.',
      'Reference creatives may guide composition, hierarchy, spacing, image treatment, and visual mechanism without transferring third-party identity or branding.',
    ].join('\n'),
  },
  guardrails: {
    approvedClaims: [
      'TRA is a U.S. tax-relief service business that helps people dealing with IRS and tax problems.',
      'TRA provides a free/no-cost tax-debt consultation.',
      "TRA's stated process is Consultation, Research, Resolution.",
      'TRA provides tax-debt and tax-resolution related services described in the approved company context.',
    ].join('\n'),
  },
};

const allowedKeys = {
  knowledgeBase: new Set(KNOWLEDGE_BASE_FIELDS.map((field) => field.key)),
  brandGuidelines: new Set(BRAND_GUIDELINE_FIELDS.map((field) => field.key)),
  guardrails: new Set(GUARDRAIL_FIELDS.map((field) => field.key)),
};

const sanitizeText = (value: unknown, max = MAX_FIELD_LENGTH) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const sanitizeSection = (
  value: unknown,
  keys: Set<string>
): CompanyFields | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const result: CompanyFields = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!keys.has(key)) continue;
    const normalized = sanitizeText(raw);
    if (normalized) result[key] = normalized;
  }
  return Object.keys(result).length ? result : undefined;
};

export function normalizeRuntimeCompanyProfile(
  input: unknown
): RuntimeCompanyProfileSnapshot | undefined {
  if (input === undefined || input === null) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;

  const body = input as Record<string, unknown>;
  const knowledgeBase = sanitizeSection(
    body.knowledgeBase,
    allowedKeys.knowledgeBase
  );
  const brandGuidelines = sanitizeSection(
    body.brandGuidelines,
    allowedKeys.brandGuidelines
  );
  const guardrails = sanitizeSection(body.guardrails, allowedKeys.guardrails);
  const websiteUrl = sanitizeText(body.websiteUrl, MAX_URL_LENGTH);

  return {
    ...(websiteUrl ? { websiteUrl } : {}),
    ...(knowledgeBase ? { knowledgeBase } : {}),
    ...(brandGuidelines ? { brandGuidelines } : {}),
    ...(guardrails ? { guardrails } : {}),
  };
}

export function readStoredRuntimeCompanyProfile(): RuntimeCompanyProfileSnapshot | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const saved = window.localStorage.getItem(COMPANY_PROFILE_STORAGE_KEY);
    return saved ? normalizeRuntimeCompanyProfile(JSON.parse(saved)) : undefined;
  } catch {
    return undefined;
  }
}

const mergeSection = (
  baseline: CompanyFields,
  approved: CompanyFields | undefined,
  runtime: CompanyFields | undefined
): CompanyFields => {
  const merged = { ...baseline };
  for (const [key, value] of Object.entries(approved || {})) {
    if (value.trim() && !merged[key]?.trim()) merged[key] = value.trim();
  }
  for (const [key, value] of Object.entries(runtime || {})) {
    if (value.trim()) merged[key] = value.trim();
  }
  return merged;
};

export function mergeRuntimeCompanyProfile(
  runtime?: RuntimeCompanyProfileSnapshot
): CompanyProfile {
  return {
    websiteUrl: runtime?.websiteUrl || DEFAULT_COMPANY_PROFILE.websiteUrl,
    knowledgeBase: mergeSection(
      DEFAULT_COMPANY_PROFILE.knowledgeBase,
      approvedBaseline.knowledgeBase,
      runtime?.knowledgeBase
    ),
    brandGuidelines: mergeSection(
      DEFAULT_COMPANY_PROFILE.brandGuidelines,
      approvedBaseline.brandGuidelines,
      runtime?.brandGuidelines
    ),
    guardrails: mergeSection(
      DEFAULT_COMPANY_PROFILE.guardrails,
      approvedBaseline.guardrails,
      runtime?.guardrails
    ),
  };
}

const field = (fields: CompanyFields, key: string) => fields[key]?.trim() || '';

export function buildCreativeCompanyContext(
  runtime?: RuntimeCompanyProfileSnapshot
): CreativeCompanyContext {
  const profile = mergeRuntimeCompanyProfile(runtime);
  const knowledge = profile.knowledgeBase;
  const brand = profile.brandGuidelines;
  const guardrails = profile.guardrails;

  const customerInsights = [
    field(knowledge, 'targetCustomers'),
    field(knowledge, 'customerProblems'),
    field(knowledge, 'desiredOutcomes'),
    field(knowledge, 'proof'),
  ]
    .filter(Boolean)
    .join('\n');

  return {
    companySummary: field(knowledge, 'companySummary'),
    servicesOffers: field(knowledge, 'servicesOffers'),
    targetCustomers: field(knowledge, 'targetCustomers'),
    customerProblems: field(knowledge, 'customerProblems'),
    desiredOutcomes: field(knowledge, 'desiredOutcomes'),
    differentiators: field(knowledge, 'differentiators'),
    proof: field(knowledge, 'proof'),
    faqsFacts: field(knowledge, 'faqsFacts'),
    brandColors: field(brand, 'brandColors'),
    fonts: field(brand, 'fonts'),
    voiceTone: field(brand, 'voiceTone'),
    visualStyle: field(brand, 'visualStyle'),
    copyStyle: field(brand, 'copyStyle'),
    neverSay: field(guardrails, 'neverSay'),
    approvedClaims: field(guardrails, 'approvedClaims'),
    claimsRequiringProof: field(guardrails, 'claimsRequiringProof'),
    requiredDisclaimers: field(guardrails, 'requiredDisclaimers'),
    testimonialsStatisticsRules: field(
      guardrails,
      'testimonialsStatisticsRules'
    ),
    industryComplianceRules: field(guardrails, 'industryComplianceRules'),
    customerInsights,
  };
}

const knownOrUnknown = (value: string) => value || '[UNKNOWN / NOT APPROVED]';

export function formatCreativeCompanyContext(
  context: CreativeCompanyContext
): string {
  return `APPROVED TRA COMPANY CONTEXT\n\nCompany / service summary:\n${knownOrUnknown(context.companySummary)}\n\nServices / offers:\n${knownOrUnknown(context.servicesOffers)}\n\nTarget customers / personas:\n${knownOrUnknown(context.targetCustomers)}\n\nCustomer problems:\n${knownOrUnknown(context.customerProblems)}\n\nDesired outcomes:\n${knownOrUnknown(context.desiredOutcomes)}\n\nDifferentiators:\n${knownOrUnknown(context.differentiators)}\n\nApproved proof / evidence themes:\n${knownOrUnknown(context.proof)}\n\nImportant facts / FAQs:\n${knownOrUnknown(context.faqsFacts)}\n\nBrand colors:\n${knownOrUnknown(context.brandColors)}\n\nFonts / typography guidance:\n${knownOrUnknown(context.fonts)}\n\nVoice / tone:\n${knownOrUnknown(context.voiceTone)}\n\nVisual style:\n${knownOrUnknown(context.visualStyle)}\n\nCopy style:\n${knownOrUnknown(context.copyStyle)}\n\nNever say / prohibited claims:\n${knownOrUnknown(context.neverSay)}\n\nExplicitly approved claims:\n${knownOrUnknown(context.approvedClaims)}\n\nClaims requiring proof or review:\n${knownOrUnknown(context.claimsRequiringProof)}\n\nRequired disclaimers:\n${knownOrUnknown(context.requiredDisclaimers)}\n\nTestimonial / statistics rules:\n${knownOrUnknown(context.testimonialsStatisticsRules)}\n\nTax-relief / IRS compliance rules:\n${knownOrUnknown(context.industryComplianceRules)}\n\nRelevant customer-insight context:\n${knownOrUnknown(context.customerInsights)}\n\nGROUNDING RULES:\n- Treat [UNKNOWN / NOT APPROVED] as unavailable information. Do not infer or invent it.\n- User direction is creative direction, not evidence that a factual claim is approved.\n- Do not create testimonials, quotes, statistics, dollar amounts, settlement/savings claims, outcomes, guarantees, endorsements, government affiliation, or competitor claims unless the approved context explicitly supports that exact claim.\n- Claims marked as requiring proof/review remain constrained unless approved support is present.\n- Do not invent disclaimer language when the approved disclaimer field is unknown.`;
}
