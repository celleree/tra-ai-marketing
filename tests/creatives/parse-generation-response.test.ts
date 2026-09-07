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

const planning = {
  strategy: {
    category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Busy taxpayer',
    painPoint: 'Growing notices', desiredOutcome: 'A clear resolution path', emotion: 'Relief',
    hook: 'Open the letter with confidence', cta: 'Get a consultation', offer: null,
    soWhat: { surfaceMessage: 'Organize your case', functionalConsequence: 'Understand the next step', meaningfulOutcome: 'Move forward with confidence' },
    execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'photographic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' },
    visualDirection: 'A clean desk and organized documents',
  },
  selectionReason: 'Distinct strategic fit', model: 'planner-model', reasoningEffort: 'medium',
};

const generationProvenance = {
  version: 1,
  imageGeneration: { prompt: 'Exact provider prompt', model: 'gpt-image-2' },
  requestedSources: [
    {
      role: 'TRA_REFERENCE',
      mediaId: `media_${'1'.repeat(32)}`,
      sha256: '2'.repeat(64),
    },
  ],
  attachedSource: {
    type: 'TRA_REFERENCE_IMAGE',
    mediaId: `media_${'1'.repeat(32)}`,
    sha256: '2'.repeat(64),
  },
  analysisSources: [
    { type: 'REFERENCE_LIBRARY', mediaId: `media_${'3'.repeat(32)}` },
  ],
  logoOverlaySource: {
    mediaId: `media_${'4'.repeat(32)}`,
    sha256: '5'.repeat(64),
  },
};

const identity = {
  conceptId: `creative_${'b'.repeat(32)}`,
  parentCreativeId: null,
  operation: 'GENERATE',
  fingerprint: 'c'.repeat(64),
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

  it('preserves a supported placement in an SSE creative', async () => {
    let received: unknown;
    await consumeGenerationEventStream(
      streamResponse([
        `event: creative\ndata: {"creative":${JSON.stringify({ ...creative, placement: 'PORTRAIT_4_5' })}}\n\n`,
      ]),
      (event) => {
        if (event.type === 'creative') received = event.creative.placement;
      }
    );

    expect(received).toBe('PORTRAIT_4_5');
  });

  it('preserves valid planning metadata in an SSE creative', async () => {
    let received: unknown;
    await consumeGenerationEventStream(
      streamResponse([
        `event: creative\ndata: {"creative":${JSON.stringify({ ...creative, planning })}}\n\n`,
      ]),
      (event) => {
        if (event.type === 'creative') received = event.creative.planning;
      }
    );

    expect(received).toEqual(planning);
  });

  it('validates and preserves supplied generation provenance in SSE creatives', async () => {
    let received: unknown;
    await consumeGenerationEventStream(
      streamResponse([
        `event: creative\ndata: {"creative":${JSON.stringify({ ...creative, generationProvenance })}}\n\n`,
      ]),
      (event) => {
        if (event.type === 'creative') received = event.creative.generationProvenance;
      }
    );

    expect(received).toEqual(generationProvenance);
  });

  it('validates and preserves supplied creative identity in SSE creatives', async () => {
    const identityCreative = { ...creative, id: identity.conceptId, identity };
    let received: unknown;
    await consumeGenerationEventStream(
      streamResponse([
        `event: creative\ndata: {"creative":${JSON.stringify(identityCreative)}}\n\n`,
      ]),
      (event) => {
        if (event.type === 'creative') received = event.creative.identity;
      }
    );

    expect(received).toEqual(identity);
  });

  it('rejects malformed supplied creative identity while allowing legacy absence', async () => {
    const malformed = { ...creative, id: identity.conceptId, identity: { ...identity, conceptId: creative.id } };
    await expect(
      consumeGenerationEventStream(
        streamResponse([
          `event: creative\ndata: {"creative":${JSON.stringify(malformed)}}\n\n`,
        ]),
        () => undefined
      )
    ).rejects.toThrow('Creative generation returned an invalid creative event.');
    await expect(
      consumeGenerationEventStream(
        streamResponse([`event: creative\ndata: {"creative":${JSON.stringify(creative)}}\n\n`]),
        () => undefined
      )
    ).resolves.toBeUndefined();
  });

  it('rejects malformed supplied generation provenance while allowing legacy absence', async () => {
    const malformed = `event: creative\ndata: {"creative":${JSON.stringify({
      ...creative,
      generationProvenance: {
        ...generationProvenance,
        attachedSource: { ...generationProvenance.attachedSource, sha256: '6'.repeat(64) },
      },
    })}}\n\n`;

    await expect(
      consumeGenerationEventStream(streamResponse([malformed]), () => undefined)
    ).rejects.toThrow('Creative generation returned an invalid creative event.');
    await expect(
      consumeGenerationEventStream(
        streamResponse([`event: creative\ndata: {"creative":${JSON.stringify(creative)}}\n\n`]),
        () => undefined
      )
    ).resolves.toBeUndefined();
  });

  it('rejects a malformed provided placement in an SSE creative', async () => {
    const body = `event: creative\ndata: {"creative":${JSON.stringify({ ...creative, placement: 'LANDSCAPE_16_9' })}}\n\n`;

    await expect(
      consumeGenerationEventStream(streamResponse([body]), () => undefined)
    ).rejects.toThrow('Creative generation returned an invalid creative event.');
  });

  it('rejects malformed provided planning metadata while allowing legacy absence', async () => {
    const malformed = `event: creative\ndata: {"creative":${JSON.stringify({ ...creative, planning: { ...planning, model: ' ' } })}}\n\n`;

    await expect(
      consumeGenerationEventStream(streamResponse([malformed]), () => undefined)
    ).rejects.toThrow('Creative generation returned an invalid creative event.');

    await expect(
      consumeGenerationEventStream(
        streamResponse([`event: creative\ndata: {"creative":${JSON.stringify(creative)}}\n\n`]),
        () => undefined
      )
    ).resolves.toBeUndefined();
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
