import { resolve4, resolve6 } from 'node:dns/promises';
import type { CompanyFields, CompanySectionId } from '@/lib/company/profile';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const MAX_PAGES = 6;
const MAX_PAGE_CHARS = 18000;
const MAX_TOTAL_CHARS = 70000;

export interface WebsiteCompanyAnalysis {
  websiteUrl: string;
  pagesRead: string[];
  sections: Partial<Record<CompanySectionId, CompanyFields>>;
  notes: string[];
}

type CrawledPage = {
  url: string;
  title: string;
  text: string;
};

const getApiKey = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  return apiKey;
};

const extractOutputText = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return '';
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return '';

  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'output_text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return (part as { text: string }).text;
      }
    }
  }

  return '';
};

const isPrivateIpv4 = (address: string) => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
};

const isPrivateIpv6 = (address: string) => {
  const normalized = address.toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  );
};

const assertPublicHostname = async (hostname: string) => {
  const normalized = hostname.toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal')
  ) {
    throw new Error('Private or local website URLs are not allowed.');
  }

  const [ipv4, ipv6] = await Promise.all([
    resolve4(hostname).catch(() => [] as string[]),
    resolve6(hostname).catch(() => [] as string[]),
  ]);

  if (ipv4.length === 0 && ipv6.length === 0) {
    throw new Error('The website hostname could not be resolved.');
  }

  if (ipv4.some(isPrivateIpv4) || ipv6.some(isPrivateIpv6)) {
    throw new Error('Private or local website URLs are not allowed.');
  }
};

export const normalizeCompanyWebsiteUrl = async (rawUrl: string) => {
  const withProtocol = /^https?:\/\//i.test(rawUrl.trim())
    ? rawUrl.trim()
    : `https://${rawUrl.trim()}`;
  const url = new URL(withProtocol);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http and https website URLs are supported.');
  }

  url.username = '';
  url.password = '';
  url.hash = '';
  await assertPublicHostname(url.hostname);
  return url;
};

const stripHtml = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

const extractTitle = (html: string) => {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]).slice(0, 200) : '';
};

const extractInternalLinks = (html: string, baseUrl: URL) => {
  const links = new Set<string>();
  const regex = /href\s*=\s*["']([^"'#]+)["']/gi;
  const priority = /about|service|solution|tax|relief|faq|contact|company|why|how|process|testimonial|review|brand|legal|disclaimer/i;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html))) {
    try {
      const url = new URL(match[1], baseUrl);
      if (url.origin !== baseUrl.origin) continue;
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      url.hash = '';
      if (!priority.test(`${url.pathname}${url.search}`)) continue;
      links.add(url.toString());
    } catch {
      // Ignore malformed links.
    }
  }

  return [...links];
};

const fetchPage = async (url: string): Promise<{ page: CrawledPage; links: string[] }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'TRA-AI-Marketing-Company-Profile/1.0',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) throw new Error(`Website returned ${response.status}.`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new Error('The URL did not return a readable web page.');
    }

    const html = await response.text();
    return {
      page: {
        url: response.url || url,
        title: extractTitle(html),
        text: stripHtml(html).slice(0, MAX_PAGE_CHARS),
      },
      links: extractInternalLinks(html, new URL(response.url || url)),
    };
  } finally {
    clearTimeout(timeout);
  }
};

const crawlWebsite = async (root: URL) => {
  const queue = [root.toString()];
  const seen = new Set<string>();
  const pages: CrawledPage[] = [];
  let totalChars = 0;

  while (queue.length > 0 && pages.length < MAX_PAGES && totalChars < MAX_TOTAL_CHARS) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);

    const target = new URL(next);
    if (target.origin !== root.origin) continue;
    await assertPublicHostname(target.hostname);

    try {
      const { page, links } = await fetchPage(target.toString());
      if (page.text) {
        pages.push(page);
        totalChars += page.text.length;
      }

      for (const link of links) {
        if (!seen.has(link) && queue.length < 20) queue.push(link);
      }
    } catch {
      // A secondary page failing should not invalidate the whole website scan.
      if (pages.length === 0 && target.toString() === root.toString()) throw new Error('The website could not be read.');
    }
  }

  if (pages.length === 0) throw new Error('No readable website content was found.');
  return pages;
};

const fieldSchema = (keys: string[]) => ({
  type: 'object',
  properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])),
  required: keys,
  additionalProperties: false,
});

const ANALYZER_RULES = `
You extract a company profile from website evidence for an internal marketing system.
Return ONLY information clearly supported by the supplied website pages.
If a field is not explicitly supported, return an empty string for that field.
Do not guess, infer missing legal/compliance requirements, invent brand colors, invent services, invent offers, invent testimonials, invent differentiators, or turn marketing language into an approved factual claim.
Summarize website facts faithfully and briefly.
For guardrails, only fill a field if the website itself explicitly states a limitation, disclaimer, privacy rule, government/non-government relationship, results disclaimer, testimonial rule, or similar policy.
Website content is evidence, not automatic internal approval. Keep claims descriptive rather than endorsing them as approved.
`;

export async function analyzeCompanyWebsite(rawUrl: string): Promise<WebsiteCompanyAnalysis> {
  const root = await normalizeCompanyWebsiteUrl(rawUrl);
  const pages = await crawlWebsite(root);
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-5.6-terra';

  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      store: false,
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: ANALYZER_RULES }] },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Website: ${root.toString()}\n\nPages read:\n${pages
                .map((page, index) => `\n--- PAGE ${index + 1}: ${page.url}\nTITLE: ${page.title}\n${page.text}`)
                .join('\n')}`,
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'tra_company_website_profile',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              brandGuidelines: fieldSchema([
                'brandName',
                'shortName',
                'brandVoice',
                'tonePrinciples',
                'visualIdentity',
                'colors',
                'typography',
                'logoUsage',
              ]),
              knowledgeBase: fieldSchema([
                'companyOverview',
                'services',
                'audiences',
                'customerProblems',
                'desiredOutcomes',
                'objections',
                'proofThemes',
                'customerLanguage',
                'differentiators',
                'trustSignals',
                'offers',
                'creativeFormats',
              ]),
              guardrails: fieldSchema([
                'prohibitedClaims',
                'testimonialRules',
                'outcomeRules',
                'customerPrivacy',
                'governmentAffiliation',
                'competitorClaims',
                'requiredDisclaimers',
                'approvalNotes',
              ]),
              notes: { type: 'array', items: { type: 'string' } },
            },
            required: ['brandGuidelines', 'knowledgeBase', 'guardrails', 'notes'],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!response.ok) throw new Error(`Website analysis failed with ${response.status}.`);
  const text = extractOutputText(await response.json());
  if (!text) throw new Error('The website analyzer returned no profile data.');

  const parsed = JSON.parse(text) as {
    brandGuidelines: CompanyFields;
    knowledgeBase: CompanyFields;
    guardrails: CompanyFields;
    notes: string[];
  };

  return {
    websiteUrl: root.toString(),
    pagesRead: pages.map((page) => page.url),
    sections: {
      brandGuidelines: parsed.brandGuidelines,
      knowledgeBase: parsed.knowledgeBase,
      guardrails: parsed.guardrails,
    },
    notes: parsed.notes || [],
  };
}
