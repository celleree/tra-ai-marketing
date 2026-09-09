import type { LookupAddress, LookupOptions } from 'node:dns';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agents: [] as unknown[], agentOptions: [] as unknown[], lookup: vi.fn(), providerFetch: vi.fn(),
  resolve4: vi.fn(), resolve6: vi.fn(), useActualWebsiteFetch: false, websiteFetch: vi.fn(),
}));

vi.mock('node:dns', () => ({ lookup: mocks.lookup }));
vi.mock('node:dns/promises', () => ({ resolve4: mocks.resolve4, resolve6: mocks.resolve6 }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options?: ConstructorParameters<typeof actual.Agent>[0]) {
        super(options);
        mocks.agentOptions.push(options);
        mocks.agents.push(this);
      }
    },
    fetch: (...args: Parameters<typeof actual.fetch>) => (
      mocks.useActualWebsiteFetch ? actual.fetch(...args) : mocks.websiteFetch(...args)
    ),
  };
});

import { analyzeCompanyWebsite, normalizeCompanyWebsiteUrl } from '@/lib/company/website-analyzer';

type PinnedLookup = (hostname: string, options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

const connectWithAgent = (rawUrl: string) => new Promise<LookupAddress[]>((resolve, reject) => {
  const options = mocks.agentOptions.at(-1) as { connect: { lookup: PinnedLookup } };
  options.connect.lookup(new URL(rawUrl).hostname, { all: true }, (error, addresses) => {
    if (error) reject(error);
    else resolve(addresses);
  });
});

const setLookupAnswers = (addresses: LookupAddress[]) => mocks.lookup.mockImplementation((
  _hostname: string, _options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, result: LookupAddress[]) => void,
) => callback(null, addresses));

const providerResponse = () => new Response(JSON.stringify({
  output: [{ content: [{ type: 'output_text', text: JSON.stringify({
    knowledgeBase: {}, brandGuidelines: {}, guardrails: {}, notes: [],
  }) }] }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

const htmlResponse = () => new Response('<html><title>Public</title><body>Public company</body></html>', {
  status: 200, headers: { 'Content-Type': 'text/html' },
});

describe('website analyzer network boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.useActualWebsiteFetch = false;
    process.env.OPENAI_API_KEY = 'test-key';
    mocks.agents.length = 0;
    mocks.agentOptions.length = 0;
    mocks.resolve4.mockResolvedValue(['93.184.216.34']);
    mocks.resolve6.mockResolvedValue([]);
    setLookupAnswers([{ address: '93.184.216.34', family: 4 }]);
    mocks.providerFetch.mockResolvedValue(providerResponse());
    vi.stubGlobal('fetch', mocks.providerFetch);
  });

  it.each([
    'http://0.0.0.1', 'http://10.0.0.1', 'http://100.64.0.1', 'http://127.0.0.1',
    'http://169.254.169.254/latest/meta-data', 'http://192.0.2.1', 'http://192.88.99.1',
    'http://198.18.0.1',
    'http://198.51.100.1', 'http://203.0.113.1', 'http://224.0.0.1', 'http://[::1]',
    'http://[::192.168.1.1]', 'http://[::ffff:127.0.0.1]', 'http://[64:ff9b::a9fe:a9fe]',
    'http://[2001:db8::1]', 'http://[fc00::1]', 'http://[fe80::1]', 'http://[fec0::1]',
    'http://[ff00::1]',
  ])('rejects disallowed direct address %s', async (url) => {
    await expect(normalizeCompanyWebsiteUrl(url)).rejects.toThrow('Private or local');
  });

  it.each(['https://8.8.8.8', 'https://[2606:4700:4700::1111]'])(
    'preserves valid public address %s',
    async (url) => expect((await normalizeCompanyWebsiteUrl(url)).toString()).toBe(`${url}/`),
  );

  it('uses the validated lookup answers for the public connection', async () => {
    const answers = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
    setLookupAnswers(answers);
    let connectedAddresses: LookupAddress[] = [];
    mocks.websiteFetch.mockImplementation(async (input: URL | string) => {
      connectedAddresses = await connectWithAgent(input.toString());
      return htmlResponse();
    });

    const analysis = await analyzeCompanyWebsite('https://public.example');

    expect(connectedAddresses).toEqual(answers);
    expect(mocks.websiteFetch.mock.calls[0][0].toString()).toBe('https://public.example/');
    expect(analysis.pagesRead).toEqual(['https://public.example/']);
    expect(mocks.providerFetch).toHaveBeenCalledOnce();
    expect(mocks.agents[0]).toMatchObject({ closed: true });
  });

  it('revalidates a redirect destination before another connection', async () => {
    mocks.resolve4.mockImplementation(async (hostname: string) => (
      hostname === 'private.example' ? ['192.168.1.10'] : ['93.184.216.34']
    ));
    mocks.websiteFetch.mockImplementation(async (input: URL | string) => {
      await connectWithAgent(input.toString());
      return new Response('redirect', { status: 302, headers: { Location: 'http://private.example/admin' } });
    });

    await expect(analyzeCompanyWebsite('https://public.example')).rejects.toThrow('could not be read');
    expect(mocks.websiteFetch).toHaveBeenCalledOnce();
    expect(mocks.providerFetch).not.toHaveBeenCalled();
    expect(mocks.agents[0]).toMatchObject({ closed: true });
  });

  it.each(['127.0.0.1', '192.88.99.1'])(
    'fails closed when the connection-time DNS answer rebinds to %s', async (address) => {
      mocks.useActualWebsiteFetch = true;
      setLookupAnswers([{ address, family: 4 }]);

      await expect(analyzeCompanyWebsite('https://public.example')).rejects.toThrow('could not be read');
      expect(mocks.websiteFetch).not.toHaveBeenCalled();
      expect(mocks.providerFetch).not.toHaveBeenCalled();
      expect(mocks.agents[0]).toMatchObject({ closed: true });
    },
  );
});
