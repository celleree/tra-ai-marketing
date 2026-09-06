import { describe, expect, it } from 'vitest';
import {
  consumeGenerationEventStream,
  isGenerationEventStream,
  parseGenerationResponse,
} from '@/lib/creatives/parse-generation-response';

const response = (body: string, status = 200) =>
  new Response(body, { status });

const encoder = new TextEncoder();
const streamResponse = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } }
  );

const creative = {
  id: 'creative_abc',
  index: 2,
  category: 'customer-problems',
  format: 'direct-response',
  image: {
    id: `media_${'a'.repeat(32)}`,
    fileName: `media_${'a'.repeat(32)}.png`,
    originalName: 'generated.png',
    mimeType: 'image/png',
    size: 12,
    url: `/api/media/files/media_${'a'.repeat(32)}.png`,
  },
  copy: { primaryText: 'Primary', headline: 'Headline', description: 'Description' },
};

const videoFrameSelection = {
  libraryId: `video-library:${'b'.repeat(64)}`,
  sourceVideoMediaId: `media_${'c'.repeat(32)}`,
  sourceVideoContentHash: 'd'.repeat(64),
  frames: [
    {
      frameIndex: 0,
      libraryFrameId: `video-frame:${'e'.repeat(64)}`,
      candidateFrameSha256: 'f'.repeat(64),
      timestampMs: 250,
      approvedPngSha256: 'a'.repeat(64),
    },
  ],
};

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

  it('recognizes and consumes events split across reader chunks', async () => {
    const received: string[] = [];
    const stream = streamResponse([
      'event: creative\ndata: {"creative":',
      `${JSON.stringify(creative)}}\n\n`,
      'event: complete\ndata: {"requestedCount":2,"successfulCount":1,"failedCount":1,"successfulIndexes":[2],"failedIndexes":[1]}\n\n',
    ]);

    expect(isGenerationEventStream(stream)).toBe(true);
    await consumeGenerationEventStream(stream, (event) => {
      received.push(event.type === 'creative' ? `creative:${event.creative.index}` : event.type);
    });

    expect(received).toEqual(['creative:2', 'complete']);
  });

  it('consumes multiple validated events from one reader chunk', async () => {
    const received: string[] = [];
    const stream = streamResponse([
      `event: error\ndata: {"index":1,"error":"Creative 1 could not be generated."}\n\nevent: creative\ndata: {"creative":${JSON.stringify(creative)}}\n\n`,
    ]);

    await consumeGenerationEventStream(stream, (event) => {
      received.push(
        event.type === 'error'
          ? `error:${event.index}`
          : event.type === 'creative'
            ? `creative:${event.creative.index}`
            : 'complete'
      );
    });

    expect(received).toEqual(['error:1', 'creative:2']);
  });

  it('validates and preserves selected TRA video frame provenance in SSE creatives', async () => {
    let received: unknown;
    await consumeGenerationEventStream(
      streamResponse([
        `event: creative\ndata: {"creative":${JSON.stringify({ ...creative, videoFrameSelection })}}\n\n`,
      ]),
      (event) => {
        if (event.type === 'creative') received = event.creative.videoFrameSelection;
      }
    );

    expect(received).toEqual(videoFrameSelection);
  });

  it.each([
    'event: creative\ndata: {"creative":{"index":1}}\n\n',
    'event: error\ndata: {"index":0,"error":"No"}\n\n',
    'event: complete\ndata: {"requestedCount":2,"successfulCount":2,"failedCount":0,"successfulIndexes":[1],"failedIndexes":[]}\n\n',
    'event: unknown\ndata: {}\n\n',
    'event: creative\ndata: not-json\n\n',
  ])('fails safely for malformed stream event data', async (body) => {
    const received: string[] = [];

    await expect(
      consumeGenerationEventStream(streamResponse([body]), (event) => {
        received.push(event.type);
      })
    ).rejects.toThrow('Creative generation returned');
    expect(received).toEqual([]);
  });
});
