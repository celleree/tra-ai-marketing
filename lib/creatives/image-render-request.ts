export type ImageRenderPurpose = 'diagnostic' | 'staging-smoke' | 'production';

/** Purpose is server configuration, never a browser-selected cost override. */
export function imageRenderPurpose(): ImageRenderPurpose {
  const value = process.env.TRA_IMAGE_PURPOSE;
  if (value === undefined || value === '') {
    return process.env.VERCEL_ENV === 'production' && process.env.NODE_ENV === 'production'
      ? 'production' : 'diagnostic';
  }
  if (value === 'diagnostic' || value === 'staging-smoke' || value === 'production') return value;
  throw new Error('TRA_IMAGE_PURPOSE must be diagnostic, staging-smoke or production.');
}

/** Normalize the actual paid request while preserving prompt and attachment bytes. */
export function prepareImageRenderRequest(input: string, init: RequestInit, purpose = imageRenderPurpose()): RequestInit {
  if (!['https://api.openai.com/v1/images/generations', 'https://api.openai.com/v1/images/edits'].includes(input)
    || init.method !== 'POST') throw new Error('Unsupported image provider request.');
  const form = init.body instanceof FormData ? new FormData() : null;
  let values: Record<string, unknown>;
  if (form) {
    for (const [name, value] of (init.body as FormData).entries()) form.append(name, value);
    values = Object.fromEntries(form.entries());
  } else {
    if (typeof init.body !== 'string') throw new Error('Image provider request body is required.');
    values = JSON.parse(init.body);
  }
  if (!values || Array.isArray(values) || typeof values !== 'object'
    || typeof values.prompt !== 'string' || !values.prompt.trim()
    || !['1024x1024', '1024x1280', '1152x2048'].includes(String(values.size))
    || !['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'].includes(String(values.model))) {
    throw new Error('Image provider request requires an explicit prompt, supported model and placement size.');
  }
  if (purpose === 'diagnostic' && values.model !== 'gpt-image-2.5-sunburst') {
    throw new Error('Diagnostic images require the production Sunburst model without fallback.');
  }
  const parameters = { ...values, quality: purpose === 'diagnostic' ? 'low' : 'high',
    n: 1, output_format: 'png', stream: false, partial_images: 0 };
  if (form) {
    for (const name of ['quality', 'n', 'output_format', 'stream', 'partial_images'] as const) {
      form.set(name, String(parameters[name]));
    }
  }
  return { ...init, body: form ?? JSON.stringify(parameters) };
}
