import { resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { CompanyFields, CompanySectionId } from '@/lib/company/profile';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const MAX_PAGES = 6;
const MAX_PAGE_CHARS = 18000;
const MAX_TOTAL_CHARS = 70000;
const MAX_REDIRECTS = 4;

export interface WebsiteCompanyAnalysis {
  websiteUrl: string;
  pagesRead: string[];
  sections: Partial<Record<CompanySectionId, CompanyFields>>;
  notes: string[];
}

type CrawledPage = { url: string; title: string; text: string };

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
  if (parts.length !== 4 || parts.some(Number.isNaN)) return true;
  const [a, b] = parts;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
};

const isPrivateIpv6 = (address: string) => {
  const value = address.toLowerCase();
  return (
    value === '::' || value === '::1' || value.startsWith('fc') ||
    value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') ||
    value.startsWith('fea') || value.startsWith('feb')
  );
};

const assertPublicHostname = async (hostname: string) => {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.local') || normalized.endsWith('.internal')) {
    throw new Error('Private or local website URLs are not allowed.');
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    if (isPrivateIpv4(normalized)) throw new Error('Private or local website URLs are not allowed.');
    return;
  }
  if (ipVersion === 6) {
    if (isPrivateIpv6(normalized)) throw new Error('Private or local website URLs are not allowed.');
    return;
  }

  const [ipv4, ipv6] = await Promise.all([
    resolve4(normalized).catch(() => [] as string[]),
    resolve6(normalized).catch(() => [] as string[]),
  ]);
  if (ipv4.length === 0 && ipv6.length === 0) throw new Error('The website hostname could not be resolved.');
  if (ipv4.some(isPrivateIpv4) || ipv6.some(isPrivateIpv6)) {
    throw new Error('Private or local website URLs are not allowed.');
  }
};

const assertPublicUrl = async (url: URL) => {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https website URLs are supported.');
  if (url.username || url.password) throw new Error('Website URLs with embedded credentials are not allowed.');
  await assertPublicHostname(url.hostname);
};

export const normalizeCompanyWebsiteUrl = async (rawUrl: string) => {
  const withProtocol = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
  const url = new URL(withProtocol);
  url.hash = '';
  await assertPublicUrl(url);
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

const extractImageSignals = (html: string, baseUrl: URL) => {
  const logoCandidates = new Set<string>();
  const imageAlts = new Set<string>();
  const imageRegex = /<img\b[^>]*>/gi;
  let imageMatch: RegExpExecArray | null;

  while ((imageMatch = imageRegex.exec(html))) {
    const tag = imageMatch[0];
    const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1]?.trim();
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();

    if (alt) imageAlts.add(alt);
    if (src && /logo|brand/i.test(tag)) {
      try {
        logoCandidates.add(new URL(src, baseUrl).toString());
      } catch {
        // Ignore malformed asset URLs.
      }
    }
  }

  const signals: string[] = [];
  if (logoCandidates.size > 0) {
    signals.push(`Logo candidate URLs found in website markup: ${[...logoCandidates].slice(0, 4).join(', ')}`);
  }
  if (imageAlts.size > 0) {
    signals.push(`Image descriptions from alt text: ${[...imageAlts].slice(0, 20).join(' | ')}`);
  }
  return signals.join('\n');
};

const extractInternalLinks = (html: string, baseUrl: URL) => {
  const links = new Set<string>();
  const regex = /href\s*=\s*["']([^"'#]+)["']/gi;
  const priority = /about|service|solution|tax|relief|faq|contact|company|why|how|process|testimonial|review|brand|legal|disclaimer|privacy|terms/i;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html))) {
    try {
      const url = new URL(match[1], baseUrl);
      if (url.origin !== baseUrl.origin || !['http:', 'https:'].includes(url.protocol)) continue;
      url.hash = '';
      if (!priority.test(`${url.pathname}${url.search}`)) continue;
      links.add(url.toString());
    } catch {
      // Ignore malformed links.
    }
  }
  return [...links];
};

const fetchWithSafeRedirects = async (initialUrl: URL, signal: AbortSignal) => {
  let current = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await assertPublicUrl(current);
    const response = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': 'TRA-AI-Marketing-Company-Profile/1.0',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current };
    const location = response.headers.get('location');
    if (!location) throw new Error('Website redirect was missing a destination.');
    current = new URL(location, current);
  }
  throw new Error('Website redirected too many times.');
};

const fetchPage = async (url: URL): Promise<{ page: CrawledPage; links: string[] }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const { response, finalUrl } = await fetchWithSafeRedirects(url, controller.signal);
    if (!response.ok) throw new Error(`Website returned ${response.status}.`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new Error('The URL did not return a readable web page.');
    }
    const html = await response.text();
    const imageSignals = extractImageSignals(html, finalUrl);
    const visibleText = stripHtml(html);
    return {
      page: {
        url: finalUrl.toString(),
        title: extractTitle(html),
        text: [visibleText, imageSignals].filter(Boolean).join('\n\n').slice(0, MAX_PAGE_CHARS),
      },
      links: extractInternalLinks(html, finalUrl),
    };
  } finally {
    clearTimeout(timeout);
  }
};

const crawlWebsite = async (root: URL) => {
  const queue = [root.toString()];
  const seen = new Set<string>();
  const pages: CrawledPage[] = [];
  let allowedOrigin = root.origin;
  let totalChars = 0;

  while (queue.length > 0 && pages.length < MAX_PAGES && totalChars < MAX_TOTAL_CHARS) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    const target = new URL(next);
    if (pages.length > 0 && target.origin !== allowedOrigin) continue;

    try {
      const { page, links } = await fetchPage(target);
      const pageOrigin = new URL(page.url).origin;
      if (pages.length === 0) allowedOrigin = pageOrigin;
      if (pageOrigin !== allowedOrigin) continue;
      if (page.text) {
        pages.push(page);
        totalChars += page.text.length;
      }
      for (const link of links) if (!seen.has(link) && queue.length < 20) queue.push(link);
    } catch {
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
Return ONLY information supported by the supplied website pages or asset signals.
If a field is not supported, return an empty string for that field.
Do not invent services, offers, pricing, customers, outcomes, differentiators, proof, colors, fonts, testimonials, statistics, legal requirements, claims, or compliance rules.
You may summarize observable writing tone and copy style from the website text, but do not claim an internal brand rule unless the site supports it.
For Logo, use a URL only when the supplied markup signals clearly identify it as a logo/brand asset. Otherwise leave it blank.
For Approved claims, do NOT treat ordinary website marketing copy as internal approval. Leave it blank unless the website explicitly identifies language or claims as approved/authorized for use.
For Never say, Claims requiring proof/review, Required disclaimers, Testimonials & statistics rules, and Industry/compliance rules, fill only what is explicitly supported by disclaimers, legal language, policy pages, or equivalent website evidence.
Website content is evidence, not automatic internal approval. Keep unsupported or ambiguous fields blank.
`;

export async function analyzeCompanyWebsite(rawUrl: string): Promise<WebsiteCompanyAnalysis> {
  const root = await normalizeCompanyWebsiteUrl(rawUrl);
  const pages = await crawlWebsite(root);
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-5.6-terra';
  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      store: false,
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: ANALYZER_RULES }] },
        {
          role: 'user',
          content: [{
            type: 'input_text',
            text: `Website: ${root.toString()}\n\nPages read:\n${pages.map((page, index) => `\n--- PAGE ${index + 1}: ${page.url}\nTITLE: ${page.title}\n${page.text}`).join('\n')}`,
          }],
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
              knowledgeBase: fieldSchema([
                'companySummary',
                'servicesOffers',
                'targetCustomers',
                'customerProblems',
                'desiredOutcomes',
                'differentiators',
                'proof',
                'faqsFacts',
              ]),
              brandGuidelines: fieldSchema([
                'logo',
                'brandColors',
                'fonts',
                'voiceTone',
                'visualStyle',
                'copyStyle',
              ]),
              guardrails: fieldSchema([
                'neverSay',
                'approvedClaims',
                'claimsRequiringProof',
                'requiredDisclaimers',
                'testimonialsStatisticsRules',
                'industryComplianceRules',
              ]),
              notes: { type: 'array', items: { type: 'string' } },
            },
            required: ['knowledgeBase','brandGuidelines','guardrails','notes'],
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
    knowledgeBase: CompanyFields;
    brandGuidelines: CompanyFields;
    guardrails: CompanyFields;
    notes: string[];
  };

  return {
    websiteUrl: pages[0]?.url || root.toString(),
    pagesRead: pages.map((page) => page.url),
    sections: {
      knowledgeBase: parsed.knowledgeBase,
      brandGuidelines: parsed.brandGuidelines,
      guardrails: parsed.guardrails,
    },
    notes: parsed.notes || [],
  };
}
