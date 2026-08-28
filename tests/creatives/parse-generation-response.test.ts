import { describe, expect, it } from 'vitest';
import { parseGenerationResponse } from '@/lib/creatives/parse-generation-response';

const response = (body: string, status = 200) =>
  new Response(body, { status });

describe('parseGenerationResponse', () => {
  it('reports an empty response with its HTTP status', async () => {
    await expect(parseGenerationResponse(response(''))).resolves.toEqual({
      error: 'Creative generation returned an empty server response (HTTP 200).',
    });
  });

  it('reports malformed JSON from a successful response', async () => {
    await expect(parseGenerationResponse(response('{'))).resolves.toEqual({
      error: 'Creative generation returned an invalid server response.',
    });
  });

  it('reports malformed JSON from a non-OK response with its HTTP status', async () => {
    await expect(parseGenerationResponse(response('{', 502))).resolves.toEqual({
      error:
        'Creative generation was interrupted by the server before it could return a normal response (HTTP 502).',
    });
  });

  it('reports a structurally invalid JSON payload from a non-OK response with its HTTP status', async () => {
    await expect(
      parseGenerationResponse(response(JSON.stringify(null), 503))
    ).resolves.toEqual({
      error:
        'Creative generation was interrupted by the server before it could return a normal response (HTTP 503).',
    });
  });

  it.each([null, 'invalid', 42, false, []])(
    'reports structurally invalid JSON value %j',
    async (value) => {
      await expect(
        parseGenerationResponse(response(JSON.stringify(value)))
      ).resolves.toEqual({
        error: 'Creative generation returned an invalid server response.',
      });
    }
  );

  it('preserves a valid API error payload', async () => {
    await expect(
      parseGenerationResponse(response(JSON.stringify({ error: 'Try again later.' }), 503))
    ).resolves.toEqual({ error: 'Try again later.' });
  });

  it('preserves a valid creatives payload', async () => {
    await expect(
      parseGenerationResponse(response(JSON.stringify({ creatives: [] })))
    ).resolves.toEqual({ creatives: [] });
  });
});
