import {
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreativeRecord } from '@/lib/creatives/generated';

const { mkdirMock, readFileMock, sendMock, writeFileMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(),
  readFileMock: vi.fn(),
  sendMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  mkdir: mkdirMock,
  readFile: readFileMock,
  writeFile: writeFileMock,
}));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn(function MockS3Client() {
      return { send: sendMock };
    }),
  };
});

import { listCreatives, saveCreativeBatch } from '@/lib/creatives/storage';

const record = (hex: string, createdAt: string): CreativeRecord => ({
  id: `creative_${hex.repeat(32)}`,
  createdAt,
  image: {
    id: `media_${hex.repeat(32)}`,
    fileName: `media_${hex.repeat(32)}.png`,
    originalName: 'creative.png',
    mimeType: 'image/png',
    size: 128,
    url: `/api/media/files/media_${hex.repeat(32)}.png`,
  },
  category: 'customer-problems',
  copy: {
    primaryText: 'Primary text',
    headline: 'Headline',
    description: 'Description',
  },
});

const r2Response = (items: CreativeRecord[], etag: string) => ({
  ETag: etag,
  Body: {
    transformToString: vi
      .fn()
      .mockResolvedValue(JSON.stringify({ version: 1, items })),
  },
});

const configureR2 = () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('R2_ACCOUNT_ID', 'account-id');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'access-key-id');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'secret-access-key');
  vi.stubEnv('R2_BUCKET_NAME', 'bucket-name');
};

const planning: NonNullable<CreativeRecord['planning']> = {
  strategy: {
    category: 'customer-problems', awarenessStage: 'problem-aware', persona: 'Busy taxpayer', painPoint: 'Growing notices', desiredOutcome: 'A clear resolution path', emotion: 'Relief', hook: 'Open the letter with confidence', cta: 'Get a consultation', offer: null,
    soWhat: { surfaceMessage: 'We help organize your tax case', functionalConsequence: 'You understand the next step', meaningfulOutcome: 'You can move forward with confidence' },
    execution: { subjectSource: 'non-human', composition: 'single-focus', imageTreatment: 'photographic', textDensity: 'low', ctaTreatment: 'button', typographyHierarchy: 'headline-dominant' }, visualDirection: 'A clean desk and organized documents',
  }, selectionReason: 'Distinct strategic fit', model: 'planner-model', reasoningEffort: 'medium' as const,
};

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  mkdirMock.mockReset().mockResolvedValue(undefined);
  readFileMock.mockReset();
  sendMock.mockReset();
  writeFileMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('TRA creative storage', () => {
  it('round-trips generated metadata while retaining legacy records', async () => {
    const legacy = record('a', '2026-08-20T12:00:00.000Z');
    const generated = { ...record('b', '2026-08-25T12:00:00.000Z'), format: 'direct-response' as const, placement: 'PORTRAIT_4_5' as const, planning };
    readFileMock.mockResolvedValueOnce(JSON.stringify({ version: 1, items: [legacy] }));
    await saveCreativeBatch([generated]);
    const encoded = writeFileMock.mock.calls[0][1] as string;
    readFileMock.mockResolvedValueOnce(encoded);
    await expect(listCreatives()).resolves.toEqual([generated, legacy]);
  });

  it.each([
    ['format', { format: 'unsupported' }],
    ['placement', { placement: 'LANDSCAPE_16_9' }],
    ['planning', { planning: { ...planning, reasoningEffort: 'high' } }],
  ])('rejects malformed supplied %s metadata', async (_label, metadata) => {
    await expect(saveCreativeBatch([{ ...record('b', '2026-08-25T12:00:00.000Z'), ...metadata } as CreativeRecord])).rejects.toThrow('One or more creative records are invalid.');
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('merges a generation batch in one read-modify-write cycle', async () => {
    const existing = record('a', '2026-08-20T12:00:00.000Z');
    const generated = [
      record('b', '2026-08-25T12:00:00.000Z'),
      record('c', '2026-08-25T12:00:00.000Z'),
    ];
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({ version: 1, items: [existing] })
    );

    await expect(saveCreativeBatch(generated)).resolves.toEqual(generated);

    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(writeFileMock.mock.calls[0][1] as string);
    expect(saved.items.map((item: CreativeRecord) => item.id)).toEqual([
      generated[0].id,
      generated[1].id,
      existing.id,
    ]);
  });

  it('rejects duplicate IDs within the submitted batch', async () => {
    const duplicate = record('b', '2026-08-25T12:00:00.000Z');

    await expect(saveCreativeBatch([duplicate, duplicate])).rejects.toThrow(
      'Creative IDs must be unique within a batch.'
    );
    expect(readFileMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('rejects an ID that is already persisted', async () => {
    const existing = record('a', '2026-08-20T12:00:00.000Z');
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({ version: 1, items: [existing] })
    );

    await expect(saveCreativeBatch([existing])).rejects.toThrow(
      'A creative with this ID already exists.'
    );
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('serializes simultaneous local batch saves', async () => {
    let current = JSON.stringify({ version: 1, items: [] });
    let releaseFirstWrite: () => void = () => undefined;
    let markFirstWriteStarted: () => void = () => undefined;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });

    readFileMock.mockImplementation(async () => current);
    writeFileMock
      .mockImplementationOnce(async (_path, raw) => {
        markFirstWriteStarted();
        await firstWriteBlocked;
        current = raw as string;
      })
      .mockImplementation(async (_path, raw) => {
        current = raw as string;
      });

    const first = record('b', '2026-08-25T12:00:00.000Z');
    const second = record('c', '2026-08-25T12:01:00.000Z');
    const firstSave = saveCreativeBatch([first]);
    await firstWriteStarted;
    const secondSave = saveCreativeBatch([second]);

    await Promise.resolve();
    expect(readFileMock).toHaveBeenCalledTimes(1);
    releaseFirstWrite();
    await Promise.all([firstSave, secondSave]);

    expect(readFileMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(current).items.map((item: CreativeRecord) => item.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it('uses If-None-Match when creating the R2 index', async () => {
    configureR2();
    const generated = record('b', '2026-08-25T12:00:00.000Z');
    sendMock
      .mockRejectedValueOnce({ name: 'NoSuchKey' })
      .mockResolvedValueOnce({});

    await expect(saveCreativeBatch([generated])).resolves.toEqual([generated]);

    expect(sendMock.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    const put = sendMock.mock.calls[1][0];
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect((put as PutObjectCommand).input).toMatchObject({
      Bucket: 'bucket-name',
      Key: '_metadata/tra-creatives.json',
      IfNoneMatch: '*',
    });
  });

  it('refetches and merges the latest R2 index after a write conflict', async () => {
    configureR2();
    const existing = record('a', '2026-08-20T12:00:00.000Z');
    const concurrent = record('c', '2026-08-25T11:59:00.000Z');
    const generated = record('b', '2026-08-25T12:00:00.000Z');
    sendMock
      .mockResolvedValueOnce(r2Response([existing], 'etag-1'))
      .mockRejectedValueOnce({
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      })
      .mockResolvedValueOnce(r2Response([concurrent, existing], 'etag-2'))
      .mockResolvedValueOnce({});

    await expect(saveCreativeBatch([generated])).resolves.toEqual([generated]);

    const firstPut = sendMock.mock.calls[1][0] as PutObjectCommand;
    const retryPut = sendMock.mock.calls[3][0] as PutObjectCommand;
    expect(firstPut.input.IfMatch).toBe('etag-1');
    expect(retryPut.input.IfMatch).toBe('etag-2');
    const saved = JSON.parse(retryPut.input.Body as string);
    expect(saved.items.map((item: CreativeRecord) => item.id)).toEqual([
      generated.id,
      concurrent.id,
      existing.id,
    ]);
  });

  it('bounds repeated R2 conflict retries', async () => {
    configureR2();
    const generated = record('b', '2026-08-25T12:00:00.000Z');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      sendMock
        .mockResolvedValueOnce(r2Response([], `etag-${attempt}`))
        .mockRejectedValueOnce({
          name: 'ConditionalRequestConflict',
          $metadata: { httpStatusCode: 409 },
        });
    }

    await expect(saveCreativeBatch([generated])).rejects.toMatchObject({
      name: 'ConditionalRequestConflict',
    });
    expect(sendMock).toHaveBeenCalledTimes(6);
  });

  it('does not treat malformed local JSON as an empty index', async () => {
    readFileMock.mockResolvedValueOnce('{not-json');

    await expect(listCreatives()).rejects.toThrow(
      'Creative library index contains malformed JSON.'
    );
  });

  it('propagates non-ENOENT local read failures', async () => {
    const failure = Object.assign(new Error('Permission denied'), {
      code: 'EACCES',
    });
    readFileMock.mockRejectedValueOnce(failure);

    await expect(listCreatives()).rejects.toBe(failure);
  });

  it('lists saved creatives newest first', async () => {
    const older = record('a', '2026-08-20T12:00:00.000Z');
    const newer = record('b', '2026-08-25T12:00:00.000Z');
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({ version: 1, items: [older, newer] })
    );

    await expect(listCreatives()).resolves.toEqual([newer, older]);
  });
});

it('preserves video frame provenance through saving and reloading without dropping older records', async () => {
  const previous = record('a', '2026-08-20T12:00:00.000Z');
  const generated = { ...record('b', '2026-08-25T12:00:00.000Z'), videoFrameSelection: {
    libraryId: `video-library:${'1'.repeat(64)}`, sourceVideoMediaId: `media_${'2'.repeat(32)}`,
    sourceVideoContentHash: '3'.repeat(64), frames: [{ frameIndex: 0, libraryFrameId: `video-frame:${'4'.repeat(64)}`,
      candidateFrameSha256: '5'.repeat(64), timestampMs: 500, approvedPngSha256: '6'.repeat(64) }],
  } };
  readFileMock.mockResolvedValueOnce(JSON.stringify({ version: 1, items: [previous] }));
  await saveCreativeBatch([generated]);
  const encoded = writeFileMock.mock.calls[0][1] as string;
  readFileMock.mockResolvedValueOnce(encoded);
  expect(await listCreatives()).toEqual([generated, previous]);
  writeFileMock.mockClear();
  await expect(saveCreativeBatch([{ ...generated, videoFrameSelection: { ...generated.videoFrameSelection, frames: [] } }])).rejects.toThrow();
  expect(writeFileMock).not.toHaveBeenCalled();
});
