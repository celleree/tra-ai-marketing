import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { GeneratedCreative } from '@/lib/creatives/generated';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.values)) hooks.values[slot] = value;
    return [hooks.values[slot], (next: unknown) => {
      hooks.values[slot] = typeof next === 'function' ? next(hooks.values[slot]) : next;
    }];
  },
}));
import { DirectCreativeUploader } from '@/components/creative-generator/direct-creative-uploader';

const files = ['first.png', 'second.png'].map(name => new File(['fixture'], name, { type: 'image/png' }));
const privateDetails = 'https://storage.test/private?X-Amz-Signature=PRIVATE_SIGNATURE C:\\private\\storage ACCESS_TOKEN';
const labels = ['Prepare upload', 'Transfer image', 'Confirm image', 'Save creative'];
let request: ReturnType<typeof vi.fn<typeof fetch>>;
let onUploaded: ReturnType<typeof vi.fn<(creatives: GeneratedCreative[]) => void>>;
let onUploadStart: ReturnType<typeof vi.fn<() => void>>;
const render = () => { hooks.cursor = 0; return DirectCreativeUploader({ onUploaded, onUploadStart }); };
const nodes = (tree: unknown): ReactElement<Record<string, unknown>>[] => !tree || typeof tree !== 'object' ? []
  : Array.isArray(tree) ? tree.flatMap(nodes) : 'props' in tree
    ? [tree as ReactElement<Record<string, unknown>>, ...nodes((tree as ReactElement<{ children?: unknown }>).props.children)] : [];
const html = () => renderToStaticMarkup(render());
const select = (selected = [files[0]]) => {
  const fields = nodes(render());
  const fileInput = fields.find(node => node.type === 'input' && node.props.type === 'file')!;
  (fileInput.props.onChange as (event: unknown) => void)({ target: { files: selected, value: 'selected' } });
  const primary = fields.find(node => node.type === 'textarea')!;
  (primary.props.onChange as (event: unknown) => void)({ target: { value: 'Diagnostic copy' } });
  const headline = fields.find(node => node.type === 'input' && node.props.placeholder === 'Ad headline')!;
  (headline.props.onChange as (event: unknown) => void)({ target: { value: 'Diagnostic headline' } });
};
const submit = async () => {
  const button = nodes(render()).filter(node => node.type === 'button').at(-1)!;
  (button.props.onClick as () => void)();
  await vi.waitFor(() => expect(button.props.disabled || html().includes('Uploading…')).toBe(false));
};

function responses(failureAt = -1, kind = 'http', status = 503, failName = files[0].name, fallback = false) {
  let current = files[0].name;
  request.mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === '/api/media/upload-url') current = JSON.parse(init!.body as string).fileName;
    const step = path === '/api/media/upload-url' ? 0 : path.startsWith('https:') || path === '/api/media/upload' ? 1
      : path === '/api/media/confirm' ? 2 : 3;
    if (step === failureAt && current === failName) {
      if (kind === 'network') throw new TypeError(`Load failed ${privateDetails}`);
      if (kind === 'json') return new Response(privateDetails, { status: 200 });
      if (kind === 'incomplete') return Response.json({});
      return new Response(privateDetails, { status });
    }
    const media = { id: `media_${'a'.repeat(32)}`, fileName: 'fixture.png', originalName: current,
      mimeType: 'image/png', size: 7, url: '/api/media/files/fixture.png' };
    if (step === 0) return Response.json(fallback ? { direct: false }
      : { direct: true, uploadUrl: `https://storage.test/${current}?X-Amz-Signature=PRIVATE_SIGNATURE`, media });
    if (step === 1) return path.startsWith('https:') ? new Response(null) : Response.json(media);
    if (step === 2) return Response.json({ ok: true });
    const creative = JSON.parse(init!.body as string).creatives[0];
    return Response.json({ items: [{ ...creative, createdAt: '2026-10-10T00:00:00Z' }] }, { status: 201 });
  });
}

beforeEach(() => {
  hooks.values = []; request = vi.fn<typeof fetch>();
  onUploaded = vi.fn<(creatives: GeneratedCreative[]) => void>(); onUploadStart = vi.fn<() => void>();
  vi.stubGlobal('fetch', request);
});
afterEach(() => {
  const markup = html();
  for (const secret of ['PRIVATE_SIGNATURE', 'ACCESS_TOKEN', 'storage.test', 'C:\\private', 'X-Amz']) {
    expect(markup).not.toContain(secret);
  }
  vi.unstubAllGlobals();
});

describe('finished creative upload failure feedback', () => {
  it.each([0, 1, 2, 3])('preserves stage %i and HTTP cause even when the error body is not JSON', async step => {
    const statuses = [401, 403, 404, 409];
    responses(step, 'http', statuses[step]); select(); await submit();
    expect(html()).toContain(`Image 1: ${labels[step]}: HTTP ${statuses[step]}`);
    expect(html()).toContain('0 saved successfully. 1 failed');
    expect(html()).toContain(files[0].name);
    expect(request).toHaveBeenCalledTimes(step + 1);
    expect(onUploaded).not.toHaveBeenCalled();
    expect(html()).toContain(['Sign in again', 'Storage rejected', 'was not found', 'Check company creatives'][step]);
  });

  it.each([0, 1, 2, 3])('keeps stage %i on network failure without echoing the raw exception', async step => {
    responses(step, 'network'); select(); await submit();
    expect(html()).toContain(`Image 1: ${labels[step]}: The browser could not`);
    expect(html()).not.toContain('Load failed');
    expect(request).toHaveBeenCalledTimes(step + 1);
    if (step === 3) expect(html()).toContain('the save may have completed');
  });

  it.each([0, 2, 3])('reports an unreadable successful JSON response at stage %i', async step => {
    responses(step, 'json'); select(); await submit();
    expect(html()).toContain(`${labels[step]}: The service returned an unreadable or incomplete response`);
    expect(request).toHaveBeenCalledTimes(step + 1);
  });

  it('does not accidentally use server upload when a direct plan is incomplete', async () => {
    responses(0, 'incomplete'); select(); await submit();
    expect(html()).toContain('Prepare upload: The service returned an unreadable or incomplete response');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['http', 'incomplete'])('warns about an uncertain save after a %s failure', async kind => {
    responses(3, kind, 500); select(); await submit();
    expect(html()).toContain('Save creative:');
    expect(html()).toContain('Check company creatives first; the save may have completed');
    expect(request).toHaveBeenCalledTimes(4);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('reports the server fallback transfer failure and preserves the multipart request', async () => {
    responses(1, 'http', 413, files[0].name, true); select(); await submit();
    expect(html()).toContain('Transfer image: HTTP 413');
    expect(html()).toContain('Choose a smaller image');
    expect(request.mock.calls[1][0]).toBe('/api/media/upload');
    expect((request.mock.calls[1][1]!.body as FormData).get('file')).toBeInstanceOf(File);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps successful saves, pairs errors with retained files, and retries only failures', async () => {
    responses(1, 'network', 503, files[1].name); select(files); await submit();
    expect(html()).toContain('1 saved successfully. 1 failed');
    expect(html()).toContain('Image 1: Transfer image');
    expect(html()).not.toContain(files[0].name);
    expect(html()).toContain(files[1].name);
    expect(onUploaded.mock.calls[0][0][0].image.originalName).toBe(files[0].name);
    const firstBatchCount = request.mock.calls.length;
    responses(); await submit();
    expect(JSON.parse(request.mock.calls[firstBatchCount][1]!.body as string).fileName).toBe(files[1].name);
    expect(request.mock.calls.slice(firstBatchCount).map(([url]) => String(url).split('?')[0])).toEqual([
      '/api/media/upload-url', `https://storage.test/${files[1].name}`, '/api/media/confirm', '/api/creatives',
    ]);
    expect(onUploaded).toHaveBeenCalledTimes(2);
    expect(html()).not.toContain('Upload failures');
    expect(html()).not.toContain('failed and remain');
  });

  it('clears stale diagnostics when a new file selection replaces the failed batch', async () => {
    responses(1, 'network'); select(); await submit();
    select([files[1]]);
    expect(html()).not.toContain('Upload failures');
    expect(html()).not.toContain('failed and remain');
  });
});
