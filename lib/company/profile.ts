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

export const BRAND_GUIDELINE_FIELDS = [
  { key: 'brandName', label: 'Brand name', multiline: false },
  { key: 'shortName', label: 'Short name', multiline: false },
  { key: 'brandVoice', label: 'Brand voice', multiline: true },
  { key: 'tonePrinciples', label: 'Tone principles', multiline: true },
  { key: 'visualIdentity', label: 'Visual identity', multiline: true },
  { key: 'colors', label: 'Colors', multiline: true },
  { key: 'typography', label: 'Typography', multiline: true },
  { key: 'logoUsage', label: 'Logo usage', multiline: true },
] as const;

export const KNOWLEDGE_BASE_FIELDS = [
  { key: 'companyOverview', label: 'Company overview', multiline: true },
  { key: 'services', label: 'Services', multiline: true },
  { key: 'audiences', label: 'Audience', multiline: true },
  { key: 'customerProblems', label: 'Customer problems', multiline: true },
  { key: 'desiredOutcomes', label: 'Desired outcomes', multiline: true },
  { key: 'objections', label: 'Objections and concerns', multiline: true },
  { key: 'proofThemes', label: 'Proof and trust themes', multiline: true },
  { key: 'customerLanguage', label: 'Customer language', multiline: true },
  { key: 'differentiators', label: 'Differentiators', multiline: true },
  { key: 'trustSignals', label: 'Trust signals', multiline: true },
  { key: 'offers', label: 'Offers', multiline: true },
  { key: 'creativeFormats', label: 'Approved creative formats', multiline: true },
] as const;

export const GUARDRAIL_FIELDS = [
  { key: 'prohibitedClaims', label: 'Prohibited / unsupported claims', multiline: true },
  { key: 'testimonialRules', label: 'Testimonials and reviews', multiline: true },
  { key: 'outcomeRules', label: 'Outcome and result claims', multiline: true },
  { key: 'customerPrivacy', label: 'Customer privacy', multiline: true },
  { key: 'governmentAffiliation', label: 'Government / IRS affiliation', multiline: true },
  { key: 'competitorClaims', label: 'Competitor claims', multiline: true },
  { key: 'requiredDisclaimers', label: 'Required disclaimers', multiline: true },
  { key: 'approvalNotes', label: 'Approval notes', multiline: true },
] as const;

const lines = (values: string[]) => values.join('\n');

export const DEFAULT_COMPANY_PROFILE: CompanyProfile = {
  websiteUrl: '',
  brandGuidelines: {
    brandName: 'Tax Relief Advocates',
    shortName: 'TRA',
    brandVoice:
      'Clear, professional, reassuring, patient, straightforward, approachable, and no-pressure.',
    tonePrinciples:
      'Explain things clearly. Reduce confusion rather than adding urgency. Sound competent and supportive. Prefer plain consumer language over jargon.',
    visualIdentity: '',
    colors: '',
    typography: '',
    logoUsage: '',
  },
  knowledgeBase: {
    companyOverview:
      'Tax Relief Advocates (TRA) is a tax-relief service business that helps people dealing with IRS and tax problems.',
    services: '',
    audiences:
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
    objections: lines([
      'Skepticism about tax-relief companies.',
      'Fear of high-pressure sales tactics.',
      'Concern about hidden or excessive fees.',
      'Concern about poor communication or lack of updates.',
      'Uncertainty about whether the company is legitimate.',
    ]),
    proofThemes: lines([
      'Knowledgeable representatives.',
      'Clear explanations.',
      'Responsiveness and timely follow-up.',
      'Professionalism and patience.',
      'Straightforward, no-pressure communication.',
      'Feeling genuinely cared for rather than treated like a transaction.',
    ]),
    customerLanguage: lines([
      'peace of mind',
      'explained everything clearly',
      'answered all of my questions',
      'knowledgeable',
      'professional',
      'responsive',
      'made me feel reassured',
      'smooth process',
      'no pressure',
      'straightforward help',
    ]),
    differentiators: '',
    trustSignals:
      'TRA five-star reviews repeatedly emphasize knowledgeable representatives, clear explanations, responsiveness, professionalism, patience, reassurance, and no-pressure interactions.',
    offers: '',
    creativeFormats: lines([
      'Problem → solution',
      'Simple headline',
      'Statistics / data',
      'Comparison / us-vs-them',
      'Editorial / magazine',
      'Testimonial / review',
      'Native Instagram Story',
      'Offer-first',
      'FAQ / objection',
      'Reasons why',
      'Before / after concept',
      'Meme / native social',
      'Authority / expert',
      'News-style',
      'Contrarian claim',
    ]),
  },
  guardrails: {
    prohibitedClaims:
      'Never fabricate a statistic, dollar amount, customer result, expert endorsement, guarantee, government affiliation, or competitor claim. Treat unapproved factual claims as unsupported.',
    testimonialRules:
      'Never create a fake testimonial. Never combine multiple customer stories and present the result as one real person. Do not use a customer name or quote in advertising unless TRA has confirmed permission for that specific use.',
    outcomeRules:
      'Never imply every customer gets the same result. Do not turn an individual statement such as “resolved my debt” into a general guarantee. Financial and outcome-specific claims require approved TRA source material.',
    customerPrivacy:
      'Raw reviews are research inputs, not automatic permission to use a customer name, quote, story, or claimed outcome in advertising.',
    governmentAffiliation:
      'Do not imply TRA is affiliated with the IRS or another government agency unless that claim is explicitly approved and sourced.',
    competitorClaims:
      'Do not make unsupported claims about competitors or imply comparative superiority without approved evidence.',
    requiredDisclaimers: '',
    approvalNotes:
      'AI output is not automatically approved. Factual, financial, legal, compliance, and outcome-specific claims must be grounded in approved TRA source material.',
  },
};

export const SECTION_FIELDS = {
  brandGuidelines: BRAND_GUIDELINE_FIELDS,
  knowledgeBase: KNOWLEDGE_BASE_FIELDS,
  guardrails: GUARDRAIL_FIELDS,
} as const;

export function getSectionCompletion(fields: CompanyFields) {
  const values = Object.values(fields);
  if (values.length === 0) return 0;

  const completed = values.filter((value) => value.trim().length > 0).length;
  return Math.round((completed / values.length) * 100);
}

export function getOverallCompletion(profile: CompanyProfile) {
  const values = (['brandGuidelines', 'knowledgeBase', 'guardrails'] as const).map(
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
    brandGuidelines: { ...current.brandGuidelines },
    knowledgeBase: { ...current.knowledgeBase },
    guardrails: { ...current.guardrails },
  };

  for (const section of ['brandGuidelines', 'knowledgeBase', 'guardrails'] as const) {
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
