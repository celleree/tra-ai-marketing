export type CompanySectionId =
  | 'brandGuidelines'
  | 'knowledgeBase'
  | 'guardrails';

export type CompanyFields = Record<string, string>;

export interface CompanyProfile {
  websiteUrl: string;
  brandGuidelines: CompanyFields;
  knowledgeBase: CompanyFields;
  guardrails: CompanyFields;
}

export const KNOWLEDGE_BASE_FIELDS = [
  { key: 'companySummary', label: 'Company summary', multiline: true },
  { key: 'servicesOffers', label: 'Services & offers', multiline: true },
  { key: 'targetCustomers', label: 'Target customers', multiline: true },
  { key: 'customerProblems', label: 'Customer problems', multiline: true },
  { key: 'desiredOutcomes', label: 'Desired outcomes', multiline: true },
  { key: 'differentiators', label: 'Differentiators', multiline: true },
  { key: 'proof', label: 'Proof', multiline: true },
  { key: 'faqsFacts', label: 'FAQs & important facts', multiline: true },
] as const;

export const BRAND_GUIDELINE_FIELDS = [
  { key: 'logo', label: 'Logo', multiline: false },
  { key: 'brandColors', label: 'Brand colors', multiline: true },
  { key: 'fonts', label: 'Fonts', multiline: true },
  { key: 'voiceTone', label: 'Voice & tone', multiline: true },
  { key: 'visualStyle', label: 'Visual style', multiline: true },
  { key: 'copyStyle', label: 'Copy style', multiline: true },
] as const;

export const GUARDRAIL_FIELDS = [
  { key: 'neverSay', label: 'Never say', multiline: true },
  { key: 'approvedClaims', label: 'Approved claims', multiline: true },
  { key: 'claimsRequiringProof', label: 'Claims requiring proof/review', multiline: true },
  { key: 'requiredDisclaimers', label: 'Required disclaimers', multiline: true },
  {
    key: 'testimonialsStatisticsRules',
    label: 'Testimonials & statistics rules',
    multiline: true,
  },
  {
    key: 'industryComplianceRules',
    label: 'Industry/compliance rules',
    multiline: true,
  },
] as const;

const lines = (values: string[]) => values.join('\n');

export const DEFAULT_COMPANY_PROFILE: CompanyProfile = {
  websiteUrl: '',
  knowledgeBase: {
    companySummary:
      'Tax Relief Advocates (TRA) is a tax-relief service business that helps people dealing with IRS and tax problems.',
    servicesOffers: '',
    targetCustomers:
      'People dealing with IRS or tax problems, including overwhelmed taxpayers, skeptical buyers, people who tried handling a tax issue themselves, people who received an unexpected IRS notice, and people seeking clearer next steps.',
    customerProblems: lines([
      'Stress, fear, and uncertainty around IRS or tax problems.',
      'Feeling overwhelmed trying to handle a tax issue alone.',
      'Unexpected IRS notices or back taxes.',
      'Difficulty understanding the process or knowing what to do next.',
      'Skepticism about whether a tax-relief company is legitimate or trustworthy.',
    ]),
    desiredOutcomes: lines([
      'Peace of mind.',
      'Clear next steps and a straightforward process.',
      'Relief from stress and uncertainty.',
      'Confidence that the situation is being handled by a competent team.',
      'Feeling informed rather than confused or pressured.',
    ]),
    differentiators: '',
    proof:
      'TRA five-star reviews supplied to the project repeatedly emphasize knowledgeable representatives, clear explanations, responsiveness, professionalism, patience, reassurance, and no-pressure interactions.',
    faqsFacts: '',
  },
  brandGuidelines: {
    logo: '',
    brandColors: '',
    fonts: '',
    voiceTone:
      'Clear, professional, reassuring, patient, straightforward, approachable, empathetic, and no-pressure.',
    visualStyle: '',
    copyStyle:
      'Use plain, clear consumer language. Explain things directly, avoid unnecessary jargon, and favor straightforward headlines and calls to action over hype.',
  },
  guardrails: {
    neverSay:
      'Do not fabricate guarantees, customer outcomes, dollar amounts, statistics, expert endorsements, government affiliation, or competitor claims. Do not imply every customer gets the same result.',
    approvedClaims: '',
    claimsRequiringProof:
      'Financial, legal, tax-resolution, savings, settlement, outcome-specific, comparative, statistical, and performance claims require approved source material or human review before use.',
    requiredDisclaimers: '',
    testimonialsStatisticsRules:
      'Never create a fake testimonial or combine multiple customer stories into one person. Do not use customer names, quotes, stories, claimed outcomes, or statistics in advertising unless TRA has confirmed the evidence and permission required for that specific use.',
    industryComplianceRules:
      'Do not imply TRA is affiliated with the IRS or another government agency unless that claim is explicitly approved and sourced. AI output is not automatically approved; tax-relief-specific factual, financial, legal, compliance, and outcome claims must be grounded in approved TRA source material.',
  },
};

export const SECTION_FIELDS = {
  knowledgeBase: KNOWLEDGE_BASE_FIELDS,
  brandGuidelines: BRAND_GUIDELINE_FIELDS,
  guardrails: GUARDRAIL_FIELDS,
} as const;

export function getSectionCompletion(fields: CompanyFields) {
  const values = Object.values(fields);
  if (values.length === 0) return 0;

  const completed = values.filter((value) => value.trim().length > 0).length;
  return Math.round((completed / values.length) * 100);
}

export function getOverallCompletion(profile: CompanyProfile) {
  const values = (['knowledgeBase', 'brandGuidelines', 'guardrails'] as const).map(
    (section) => getSectionCompletion(profile[section])
  );

  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function mergeWebsiteProfile(
  current: CompanyProfile,
  websiteProfile: Partial<Record<CompanySectionId, CompanyFields>>,
  websiteUrl: string
): CompanyProfile {
  const next: CompanyProfile = {
    ...current,
    websiteUrl,
    knowledgeBase: { ...current.knowledgeBase },
    brandGuidelines: { ...current.brandGuidelines },
    guardrails: { ...current.guardrails },
  };

  for (const section of ['knowledgeBase', 'brandGuidelines', 'guardrails'] as const) {
    const incoming = websiteProfile[section];
    if (!incoming) continue;

    for (const [key, value] of Object.entries(incoming)) {
      if (!value?.trim()) continue;
      if (next[section][key]?.trim()) continue;
      next[section][key] = value.trim();
    }
  }

  return next;
}
