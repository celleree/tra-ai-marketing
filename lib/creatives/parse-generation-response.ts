import {
  isCreativeCategory,
  type CreativeCategoryId,
} from '@/lib/creative-categories';
import {
  isCreativeFormat,
  type CreativeFormatId,
} from '@/lib/creative-formats';
import type { GeneratedCreative } from '@/lib/creatives/generated';
import {
  isCreativePlacement,
  type CreativePlacement,
} from '@/lib/creatives/placements';
import type { MediaAsset } from '@/lib/media/types';
import { parseGeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';

export type CreativeGenerationPayload = {
  creatives?: GeneratedCreative[];
  error?: string;
};

export type CreativeGenerationComplete = {
  requestedCount: number;
  successfulCount: number;
  failedCount: number;
  successfulIndexes: number[];
  failedIndexes: number[];
};

export type CreativeGenerationStreamEvent =
  | { type: 'creative'; creative: GeneratedCreative }
  | { type: 'error'; error: string; index?: number }
  | ({ type: 'complete' } & CreativeGenerationComplete);

const invalidResponseError = (response: Response) =>
  response.ok
    ? 'Creative generation returned an invalid server response.'
    : `Creative generation was interrupted by the server before it could return a normal response (HTTP ${response.status}).`;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isIndexList = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.every(isPositiveInteger) &&
  new Set(value).size === value.length;

const isMediaAsset = (value: unknown): value is MediaAsset => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const asset = value as Record<string, unknown>;
  return (
    typeof asset.id === 'string' &&
    typeof asset.fileName === 'string' &&
    typeof asset.originalName === 'string' &&
    typeof asset.mimeType === 'string' &&
    typeof asset.size === 'number' &&
    Number.isFinite(asset.size) &&
    typeof asset.url === 'string'
  );
};

const parseCreative = (value: unknown): GeneratedCreative | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const creative = value as Record<string, unknown>;
  const copy = creative.copy;
  const category = creative.category;
  const format = creative.format;
  const videoFrameSelection =
    creative.videoFrameSelection === undefined
      ? undefined
      : parseGeneratedVideoFrameSelection(creative.videoFrameSelection);

  if (
    typeof creative.id !== 'string' ||
    !isPositiveInteger(creative.index) ||
    typeof category !== 'string' ||
    !isCreativeCategory(category) ||
    typeof format !== 'string' ||
    !isCreativeFormat(format) ||
    (creative.placement !== undefined &&
      !isCreativePlacement(creative.placement)) ||
    !isMediaAsset(creative.image) ||
    !copy ||
    typeof copy !== 'object' ||
    Array.isArray(copy) ||
    (creative.videoFrameSelection !== undefined && !videoFrameSelection)
  ) {
    return null;
  }

  const copyRecord = copy as Record<string, unknown>;
  if (
    typeof copyRecord.primaryText !== 'string' ||
    typeof copyRecord.headline !== 'string' ||
    typeof copyRecord.description !== 'string'
  ) {
    return null;
  }

  return {
    id: creative.id,
    index: creative.index,
    category: category as CreativeCategoryId,
    format: format as CreativeFormatId,
    ...(creative.placement
      ? { placement: creative.placement as CreativePlacement }
      : {}),
    image: creative.image,
    copy: {
      primaryText: copyRecord.primaryText,
      headline: copyRecord.headline,
      description: copyRecord.description,
    },
    ...(typeof creative.referenceImageId === 'string'
      ? { referenceImageId: creative.referenceImageId }
      : {}),
    ...(typeof creative.referenceImageUrl === 'string'
      ? { referenceImageUrl: creative.referenceImageUrl }
      : {}),
    ...(typeof creative.referenceCategory === 'string' &&
    isCreativeCategory(creative.referenceCategory)
      ? { referenceCategory: creative.referenceCategory }
      : {}),
    ...(typeof creative.referenceSelectionReason === 'string'
      ? { referenceSelectionReason: creative.referenceSelectionReason }
      : {}),
    ...(videoFrameSelection ? { videoFrameSelection } : {}),
  };
};

const parseStreamEvent = (eventName: string, data: string): CreativeGenerationStreamEvent => {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new Error('Creative generation returned malformed stream event data.');
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Creative generation returned an invalid stream event.');
  }

  const record = payload as Record<string, unknown>;
  if (eventName === 'creative') {
    const creative = parseCreative(record.creative);
    if (!creative) {
      throw new Error('Creative generation returned an invalid creative event.');
    }
    return { type: 'creative', creative };
  }

  if (eventName === 'error') {
    if (
      typeof record.error !== 'string' ||
      !record.error.trim() ||
      (record.index !== undefined && !isPositiveInteger(record.index))
    ) {
      throw new Error('Creative generation returned an invalid error event.');
    }
    return {
      type: 'error',
      error: record.error,
      ...(record.index !== undefined ? { index: record.index } : {}),
    };
  }

  if (eventName === 'complete') {
    if (
      !isPositiveInteger(record.requestedCount) ||
      typeof record.successfulCount !== 'number' ||
      !Number.isInteger(record.successfulCount) ||
      record.successfulCount < 0 ||
      typeof record.failedCount !== 'number' ||
      !Number.isInteger(record.failedCount) ||
      record.failedCount < 0 ||
      !isIndexList(record.successfulIndexes) ||
      !isIndexList(record.failedIndexes) ||
      record.successfulCount !== record.successfulIndexes.length ||
      record.failedCount !== record.failedIndexes.length ||
      record.requestedCount !== record.successfulCount + record.failedCount ||
      record.successfulIndexes.some(
        (index) => index > (record.requestedCount as number)
      ) ||
      record.failedIndexes.some(
        (index) => index > (record.requestedCount as number)
      ) ||
      record.successfulIndexes.some((index) =>
        (record.failedIndexes as number[]).includes(index)
      )
    ) {
      throw new Error('Creative generation returned an invalid completion event.');
    }
    const requestedCount = record.requestedCount as number;
    const successfulCount = record.successfulCount as number;
    const failedCount = record.failedCount as number;
    const successfulIndexes = record.successfulIndexes as number[];
    const failedIndexes = record.failedIndexes as number[];
    return {
      type: 'complete',
      requestedCount,
      successfulCount,
      failedCount,
      successfulIndexes,
      failedIndexes,
    };
  }

  throw new Error('Creative generation returned an unknown stream event.');
};

const parseSseMessage = (message: string): CreativeGenerationStreamEvent | null => {
  const lines = message.split('\n');
  let eventName = '';
  const data: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart());
    } else {
      throw new Error('Creative generation returned an invalid stream message.');
    }
  }

  if (!eventName && !data.length) return null;
  if (!eventName || !data.length) {
    throw new Error('Creative generation returned an incomplete stream message.');
  }

  return parseStreamEvent(eventName, data.join('\n'));
};

export const isGenerationEventStream = (response: Response) =>
  response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ||
  false;

export const consumeGenerationEventStream = async (
  response: Response,
  onEvent: (event: CreativeGenerationStreamEvent) => void | Promise<void>
) => {
  if (!response.body) {
    throw new Error('Creative generation returned an empty event stream.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  const consumeBufferedMessages = async (flush = false) => {
    const normalized = buffered.replaceAll('\r\n', '\n');
    const messages = normalized.split('\n\n');
    buffered = flush ? '' : messages.pop() || '';
    for (const message of messages) {
      const event = parseSseMessage(message);
      if (event) await onEvent(event);
    }

  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    await consumeBufferedMessages();
  }

  buffered += decoder.decode();
  if (buffered) await consumeBufferedMessages(true);
};

export const parseGenerationResponse = async (
  response: Response
): Promise<CreativeGenerationPayload> => {
  const raw = await response.text();
  if (!raw.trim()) {
    return {
      error: `Creative generation returned an empty server response (HTTP ${response.status}).`,
    };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: invalidResponseError(response) };
    }

    return parsed as CreativeGenerationPayload;
  } catch {
    return { error: invalidResponseError(response) };
  }
};
