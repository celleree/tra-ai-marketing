import { assertGenerationAvailable, CreativeGenerationPreparationError } from '@/lib/creatives/generation-sources';
import { directGenerationExecution } from '@/lib/creatives/direct-generation-execution';
export { generatePromptOnlyCreativeImage } from '@/lib/ai/prompt-only-generation';
import { NextResponse } from 'next/server';
import { getOperatorAccess } from '@/lib/auth/server-access';
import { operatorAccessDeniedResponse } from '@/lib/auth/require-operator';
import { validateGenerateCreativeRequest } from '@/lib/creatives/generate-request';
import { GeneratedImageValidationError } from '@/lib/creatives/generated-image-validation';
import { CheckpointUnavailableError, submissionRunId } from '@/lib/creatives/durable-checkpoint';
import { parseSubmissionId, SUBMISSION_HEADER, SubmissionConflictError } from '@/lib/creatives/submission-id';
import { CreativeSourceHydrationError } from '@/lib/media/source-hydration';
import { TraVideoProcessingError } from '@/lib/video/ffmpeg';

export const runtime = 'nodejs';
export const maxDuration = 300;

const RENDER_CONCURRENCY = 2;

const encodeSseEvent = (
  encoder: TextEncoder,
  event: 'creative' | 'error' | 'complete',
  payload: object
) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);

export async function POST(request: Request) {
  const access = await getOperatorAccess();
  if (!access.allowed) return operatorAccessDeniedResponse(access);

  try {
    const body = await request.json();
    const parsed = validateGenerateCreativeRequest(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    assertGenerationAvailable(parsed.data);

    const submissionId = parseSubmissionId(request.headers.get(SUBMISSION_HEADER));
    if (!submissionId) return NextResponse.json({ error: 'A valid Idempotency-Key is required for generation.' }, { status: 400 });
    const runId = submissionRunId(access.userId, submissionId, 'direct-generation');
    const { plan: creativePlan, render: renderCreative } = await directGenerationExecution(runId, access.userId, parsed.data, request.url);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const successfulIndexes: number[] = [];
        const failedIndexes: number[] = [];
        let cursor = 0;

        const emit = (
          event: 'creative' | 'error' | 'complete',
          payload: object
        ) => controller.enqueue(encodeSseEvent(encoder, event, payload));

        const worker = async () => {
          while (true) {
            const position = cursor;
            cursor += 1;
            if (position >= creativePlan.length) return;

            const item = creativePlan[position];
            try {
              const creative = await renderCreative(item);
              successfulIndexes.push(item.index);
              emit('creative', { creative });
            } catch (error) {
              console.error(`Creative ${item.index} failed to render`, error);
              failedIndexes.push(item.index);
              emit('error', {
                index: item.index,
                error: error instanceof GeneratedImageValidationError
                  ? error.message
                  : `Creative ${item.index} could not be completed.`,
              });
            }
          }
        };

        try {
          await Promise.all(
            Array.from(
              { length: Math.min(RENDER_CONCURRENCY, creativePlan.length) },
              () => worker()
            )
          );
          successfulIndexes.sort((a, b) => a - b);
          failedIndexes.sort((a, b) => a - b);
          emit('complete', {
            requestedCount: creativePlan.length,
            successfulCount: successfulIndexes.length,
            failedCount: failedIndexes.length,
            successfulIndexes,
            failedIndexes,
          });
        } catch (error) {
          console.error('Creative generation stream failed', error);
          emit('error', {
            error: 'Creative generation was interrupted before completion.',
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof CheckpointUnavailableError || error instanceof SubmissionConflictError) {
      const status = error instanceof CheckpointUnavailableError ? error.status : 409;
      return NextResponse.json({ error: error.message }, { status, headers: { 'Cache-Control': 'private, no-store',
        ...(status === 202 ? { 'Retry-After': '2' } : {}) } });
    }
    if (error instanceof CreativeGenerationPreparationError || error instanceof CreativeSourceHydrationError || error instanceof TraVideoProcessingError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Creative generation failed', error);
    return NextResponse.json(
      { error: 'Creative generation failed. Check the server configuration and try again.' },
      { status: 500 }
    );
  }
}
