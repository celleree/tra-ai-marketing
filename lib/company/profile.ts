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
  {
    key: 'companySummary',
    label: 'Company summary',
    description: 'What the company does and where it operates.',
    multiline: true,
  },
  {
    key: 'servicesOffers',
    label: 'Services & offers',
    description: 'Services, pricing or offers, CTA, and how it works.',
    multiline: true,
  },
  {
    key: 'targetCustomers',
    label: 'Target customers',
    description: 'Who the company serves and its key personas.',
    multiline: true,
  },
  {
    key: 'customerProblems',
    label: 'Customer problems',
    description: 'Pain points, fears, and frustrations.',
    multiline: true,
  },
  {
    key: 'desiredOutcomes',
    label: 'Desired outcomes',
    description: 'What customers want to achieve or feel.',
    multiline: true,
  },
  {
    key: 'differentiators',
    label: 'Differentiators',
    description: 'Why a customer should choose this company.',
    multiline: true,
  },
  {
    key: 'proof',
    label: 'Proof',
    description: 'Reviews, testimonials, credentials, and important statistics.',
    multiline: true,
  },
  {
    key: 'faqsFacts',
    label: 'FAQs & important facts',
    description: 'Useful information the AI should know.',
    multiline: true,
  },
] as const;

export const BRAND_GUIDELINE_FIELDS = [
  {
    key: 'logo',
    label: 'Logo',
    description: 'Primary logo asset or approved logo reference.',
    multiline: false,
  },
  {
    key: 'brandColors',
    label: 'Brand colors',
    description: 'Approved brand colors and color values when known.',
    multiline: true,
  },
  {
    key: 'fonts',
    label: 'Fonts',
    description: 'Approved brand fonts or typography guidance.',
    multiline: true,
  },
  {
    key: 'voiceTone',
    label: 'Voice & tone',
    description: 'Professional, conversational, empathetic, direct, or other voice traits.',
    multiline: true,
  },
  {
    key: 'visualStyle',
    label: 'Visual style',
    description: 'Photography, graphics, people, and the overall aesthetic.',
    multiline: true,
  },
  {
    key: 'copyStyle',
    label: 'Copy style',
    description: 'Headline style, CTA style, and words or phrases the brand likes.',
    multiline: true,
  },
] as const;

export const GUARDRAIL_FIELDS = [
  {
    key: 'neverSay',
    label: 'Never say',
    description: 'Prohibited words, claims, and promises.',
    multiline: true,
  },
  {
    key: 'approvedClaims',
    label: 'Approved claims',
    description: 'Things the AI is explicitly allowed to say.',
    multiline: true,
  },
  {
    key: 'claimsRequiringProof',
    label: 'Claims requiring proof/review',
    description: 'Claims that need evidence or human review before use.',
    multiline: true,
  },
  {
    key: 'requiredDisclaimers',
    label: 'Required disclaimers',
    description: 'Disclaimer language that must appear when applicable.',
    multiline: true,
  },
  {
    key: 'testimonialsStatisticsRules',
    label: 'Testimonials & statistics rules',
    description: 'What testimonial and statistical evidence can actually be used.',
    multiline: true,
  },
  {
    key: 'industryComplianceRules',
    label: 'Industry/compliance rules',
    description: 'IRS/government affiliation and tax-relief-specific restrictions.',
    multiline: true,
  },
] as const;

const lines = (values: string[]) => values.join('\n');

export const DEFAULT_COMPANY_PROFILE: CompanyProfile = {
  websiteUrl: '',
  knowledgeBase: {
    companySummary:
      'Tax Relief Advocates (TRA) is a U.S. tax-relief service business that helps people dealing with IRS and tax problems.',
    servicesOffers: lines([
      'Free/no-cost tax-debt consultation.',
      'Review of tax hardship and IRS communications.',
      'Assessment of eligibility for IRS debt-forgiveness programs, including the IRS Fresh Start Program.',
      'Representation notification to tax authorities.',
      'Research and comparison of available debt-forgiveness programs.',
      'Negotiation with the IRS and state taxing authorities.',
      'Assistance with tax audits, tax-liability negotiation, wage garnishments, bank levies, and tax-debt resolution.',
    ]),
    targetCustomers:
      'People dealing with IRS or tax problems, including overwhelmed taxpayers, skeptical buyers, people who tried handling a tax issue themselves, people who received an unexpected IRS notice, and people seeking clearer next steps.',
    customerProblems: lines([
      'Stress, fear, and uncertainty around IRS or tax problems.',
      'Feeling overwhelmed trying to handle a tax issue alone.',
      'Unexpected IRS notices or back taxes.',
      'Difficulty understanding the process or knowing what to do next.',
      'Skepticism about whether a tax-relief company is legitimate or trustworthy.',
      'Frustration with poor communication or lack of updates.',
    ]),
    desiredOutcomes: lines([
      'Peace of mind.',
      'Clear next steps and a straightforward process.',
      'Relief from stress and uncertainty.',
      'Confidence that the situation is being handled by a competent team.',
      'Responsive, professional, no-pressure communication.',
      'Feeling informed rather than confused or pressured.',
    ]),
    differentiators: lines([
      "TRA's stated process is Consultation, Research, Resolution.",
      'TRA says it works directly with the IRS and develops a personalized strategy.',
      'TRA says its team includes tax-relief experts, attorneys, and specialized licensed tax-resolution professionals.',
    ]),
    proof:
      'TRA five-star reviews supplied to the project repeatedly emphasize knowledgeable representatives, clear explanations, responsiveness, professionalism, patience, reassurance, and no-pressure interactions. Use these as service-quality themes, not invented quotations or outcome claims.',
    faqsFacts: lines([
      'TRA says a consultation is free/no-cost.',
      'Services may not be available in all states.',
      'Fees may vary by state.',
      'Address: 16808 Armstrong Ave., Irvine, CA 92606.',
      'Phone: 800-501-4249 / 800-575-2063.',
      'Email: contact@tra.com.',
    ]),
  },
  brandGuidelines: {
    logo: '',
    brandColors: '#0577BF\n#6D6E71\n#FFFFFF\n#333333',
    fonts: '',
    voiceTone:
      'Clear, professional, reassuring, patient, straightforward, approachable, empathetic, and no-pressure.',
    visualStyle: lines([
      'Professionally art-directed, restrained, and intentional.',
      'Favor one clear focal idea, strong hierarchy, deliberate whitespace, and clean image-to-text balance over information density.',
      'Do not automatically add benefit sections, icons, trust badges, floating cards, extra text boxes, CTA bars, proof blocks, or decorative elements.',
      'If the reference is visually simple, keep the TRA adaptation visually simple.',
      'Reference creatives may guide composition, hierarchy, spacing, image treatment, and visual mechanism without transferring third-party identity or branding.',
    ]),
    copyStyle:
      'Use plain, clear consumer language. Explain things directly, avoid unnecessary jargon, favor straightforward headlines and calls to action over hype, and keep secondary copy subordinate to the primary idea.',
  },
  guardrails: {
    neverSay:
      'Do not fabricate guarantees, customer outcomes, dollar amounts, statistics, expert endorsements, government affiliation, or competitor claims. Do not imply every customer gets the same result.',
    approvedClaims: lines([
      'TRA is a U.S. tax-relief service business that helps people dealing with IRS and tax problems.',
      'TRA provides a free/no-cost tax-debt consultation.',
      "TRA's stated process is Consultation, Research, Resolution.",
      'TRA provides the tax-debt and tax-resolution related services listed in the approved Company Profile.',
    ]),
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
