import { createHash } from 'node:crypto';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sorted(item)])) : value;

/** Hash the prepared outbound request, not strategy or an earlier render brief.
 * Headers, job IDs, purpose and attempt metadata are deliberately not inputs.
 * Every body field is included by default; future provider options cannot vanish.
 */
export async function fingerprintImageRenderRequest(endpoint: string, request: RequestInit): Promise<string> {
  if (!['https://api.openai.com/v1/images/generations', 'https://api.openai.com/v1/images/edits'].includes(endpoint)
    || request.method !== 'POST') throw new Error('Unsupported image fingerprint request.');
  let body: unknown;
  let encoding: 'json' | 'multipart';
  if (request.body instanceof FormData) {
    encoding = 'multipart';
    const fields: Record<string, unknown[]> = {};
    for (const [name, value] of request.body.entries()) {
      const item = typeof value === 'string' ? { text: value } : {
        fileName: value.name, mimeType: value.type,
        sha256: sha256(Buffer.from(await value.arrayBuffer())), size: value.size,
      };
      (fields[name] ??= []).push(item);
    }
    body = fields;
  } else {
    encoding = 'json';
    if (typeof request.body !== 'string') throw new Error('Image fingerprint requires a complete request body.');
    body = JSON.parse(request.body);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid image fingerprint body.');
  }
  return sha256(JSON.stringify(sorted({ version: 1, endpoint, method: request.method, encoding, body })));
}
