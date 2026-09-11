import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditCreativePortfolio } from '@/lib/ai/portfolio-auditor';
import { portfolioAudit } from '../fixtures/portfolio-audit';
import { conceptDetails } from '../fixtures/creative-concept-details';
import type { PlannedCreativeConcept } from '@/lib/creatives/planned';

const concepts = [1, 2].map(index => ({ index, copy: { headline: `Question ${index}` }, strategy: {
  category: 'customer-problems', painPoint: 'Uncertainty', desiredOutcome: 'A next step',
  conceptDetails, soWhat: { surfaceMessage: 'Start a conversation' },
} })) as PlannedCreativeConcept[];
const response = (value: unknown) => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Astra semantic portfolio audit', () => {
  it('audits all 36 concepts through the real implementation and rejects 37 before a provider call', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture');
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => response(portfolioAudit(36)));
    vi.stubGlobal('fetch', fetchMock);
    const batch = Array.from({ length: 36 }, (_, index) => ({ ...concepts[0], index: index + 1 }));
    expect((await auditCreativePortfolio(batch)).conceptCount).toBe(36);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(JSON.parse(body.input[1].content[0].text)).toHaveLength(36);
    expect(body.text.format.schema.properties.groups.maxItems).toBe(36);
    await expect(auditCreativePortfolio([...batch, concepts[0]])).rejects.toThrow('2–36');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('submits the whole portfolio to a separate bounded audit and preserves duplicate groups', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture'); vi.stubEnv('OPENAI_TEXT_MODEL', 'gpt-6-astra');
    const groups = [{ conceptIndexes: [1, 2], proposition: 'Conversation to next steps', distinction: 'No strategic distinction; different wording' }];
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => response({ groups, executionNotes: 'Avoid automatic desk imagery.' }));
    vi.stubGlobal('fetch', fetchMock);
    const audit = await auditCreativePortfolio(concepts);
    expect(audit.groups).toEqual(groups);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toMatchObject({ model: 'gpt-6-astra', store: false, reasoning: { effort: 'medium' }, max_output_tokens: 4608 });
    expect(JSON.parse(body.input[1].content[0].text)).toHaveLength(2);
    expect(body.input[0].content[0].text).toContain('same category');
    expect(body.input[0].content[0].text).toContain('near-duplicate paraphrases');
  });
  it('fails closed on incomplete coverage, refused/incomplete output and provider failure', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture');
    const { groups, executionNotes } = portfolioAudit();
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ groups: groups.slice(0, 1), executionNotes }))
      .mockResolvedValueOnce(Response.json({ status: 'incomplete' })).mockResolvedValueOnce(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(auditCreativePortfolio(concepts)).rejects.toThrow('exactly once');
    await expect(auditCreativePortfolio(concepts)).rejects.toThrow('did not complete');
    await expect(auditCreativePortfolio(concepts)).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
