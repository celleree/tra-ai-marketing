import { describe, expect, it } from 'vitest';
import { fingerprintImageRenderRequest } from '@/lib/creatives/image-render-identity';
import { prepareImageRenderRequest } from '@/lib/creatives/image-render-request';

const endpoint = 'https://api.openai.com/v1/images/generations';
const editEndpoint = endpoint.replace('generations', 'edits');
const values = { model: 'gpt-image-2.5-sunburst', prompt: 'Exact prompt\nwith spacing  ', size: '1024x1024' };
const prepared = (body = values) => prepareImageRenderRequest(endpoint,
  { method: 'POST', body: JSON.stringify(body) }, 'production');
const hash = (body = values) => fingerprintImageRenderRequest(endpoint, prepared(body));
const multipart = (images = ['first', 'second'], names = ['person.png', 'document.png'], type = 'image/png') => {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  images.forEach((bytes, i) => form.append('image[]', new Blob([bytes], { type }), names[i]));
  return prepareImageRenderRequest(editEndpoint, { method: 'POST', body: form }, 'production');
};

describe('paid render fingerprint', () => {
  it('is stable across JSON object key order and unrelated transport metadata', async () => {
    const request = prepared();
    const fields = JSON.parse(request.body as string);
    const reversed = JSON.stringify(Object.fromEntries(Object.entries(fields).reverse()));
    const fingerprint = await fingerprintImageRenderRequest(endpoint, request);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await fingerprintImageRenderRequest(endpoint, { ...request, body: reversed,
      headers: { Authorization: 'different-secret', 'x-job-id': 'other-job' }, cache: 'no-store' })).toBe(fingerprint);
  });
  it.each([
    { model: 'gpt-image-2.5-flare' }, { prompt: 'Different copy' }, { prompt: values.prompt.trim() },
    { size: '1024x1280' }, { size: '1152x2048' },
  ])('distinguishes material planned input %j', async change => {
    expect(await hash({ ...values, ...change })).not.toBe(await hash());
  });
  it.each([{ quality: 'low' }, { n: 2 }, { output_format: 'webp' }, { background: 'transparent' },
    { input_fidelity: 'high' }, { moderation: 'low' }, { future_option: 'different' }])(
    'includes every prepared output option, including future fields %j', async change => {
      const request = prepared();
      const changed = { ...request, body: JSON.stringify({ ...JSON.parse(request.body as string), ...change }) };
      expect(await fingerprintImageRenderRequest(endpoint, changed)).not.toBe(await fingerprintImageRenderRequest(endpoint, request));
    },
  );
  it('does not treat purpose alone as an output change when resolved settings match', async () => {
    const smoke = prepareImageRenderRequest(endpoint, { method: 'POST', body: JSON.stringify(values) }, 'staging-smoke');
    expect(await fingerprintImageRenderRequest(endpoint, smoke)).toBe(await hash());
  });
  it('distinguishes endpoint, actual image bytes, attachment order, names and MIME types', async () => {
    const baseline = await fingerprintImageRenderRequest(editEndpoint, multipart());
    for (const request of [multipart(['changed', 'second']), multipart(['second', 'first']),
      multipart(undefined, ['different.png', 'document.png']), multipart(undefined, undefined, 'image/jpeg')]) {
      expect(await fingerprintImageRenderRequest(editEndpoint, request)).not.toBe(baseline);
    }
    expect(await fingerprintImageRenderRequest(endpoint, multipart())).not.toBe(baseline);
  });
  it('includes mask bytes and preserves repeated fields while ignoring scalar field order', async () => {
    const request = multipart();
    const original = await fingerprintImageRenderRequest(editEndpoint, request);
    const form = request.body as FormData;
    form.append('mask', new Blob(['mask']), 'mask.png');
    expect(await fingerprintImageRenderRequest(editEndpoint, request)).not.toBe(original);
    const reordered = new FormData();
    [...form.keys()].filter((key, i, all) => all.indexOf(key) === i).reverse()
      .forEach(key => form.getAll(key).forEach(value => reordered.append(key, value)));
    expect(await fingerprintImageRenderRequest(editEndpoint, { ...request, body: reordered }))
      .toBe(await fingerprintImageRenderRequest(editEndpoint, request));
  });
  it('rejects incomplete bodies rather than minting reusable identities', async () => {
    for (const body of [undefined, 'null', '[]', 'broken']) {
      await expect(fingerprintImageRenderRequest(endpoint, { method: 'POST', body })).rejects.toThrow();
    }
  });
});
