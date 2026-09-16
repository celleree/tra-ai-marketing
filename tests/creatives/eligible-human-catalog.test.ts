import { describe, expect, it } from 'vitest';
import { buildEligibleHumanCatalog } from '@/lib/creatives/eligible-human-catalog';
import type { ApprovedHumanFrame } from '@/lib/video/approved-human';
import type { GeneratedVideoFrameSelection } from '@/lib/video/generation-selection-contract';
import type { ApprovedTraVideoFrame } from '@/lib/video/types';

const hex = (value: number) => value.toString(16).padStart(64, '0');
const mediaId = (value: number) => `media_${value.toString(16).padStart(32, '0')}`;
const libraryId = (value: number) => `video-library:${hex(value)}`;
const frameId = (value: number) => `video-frame:${hex(value)}`;

const approvedHuman = (index: number, active = true): ApprovedHumanFrame => ({
  version: 1,
  id: `human_${hex(index)}`,
  sourceName: `Source ${index}`,
  description: `Approved person ${index}`,
  extractionVersion: 'selected-png-v1',
  approvedBy: 'operator@example.com',
  approvedAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-11T00:00:00.000Z',
  active,
  source: {
    libraryId: libraryId(index),
    sourceVideoMediaId: mediaId(index),
    sourceVideoContentHash: hex(1000 + index),
    frames: [{
      frameIndex: 0,
      libraryFrameId: frameId(index),
      candidateFrameSha256: hex(2000 + index),
      timestampMs: index * 1000,
      approvedPngSha256: hex(3000 + index),
    }],
  },
});

const selectedFrame = (index: number): GeneratedVideoFrameSelection => ({
  libraryId: libraryId(100 + index),
  sourceVideoMediaId: mediaId(100 + index),
  sourceVideoContentHash: hex(4000 + index),
  frames: [{
    frameIndex: 0,
    libraryFrameId: frameId(100 + index),
    candidateFrameSha256: hex(5000 + index),
    timestampMs: index * 1500,
    approvedPngSha256: hex(6000 + index),
  }],
});

const approvedFrame = (index: number): ApprovedTraVideoFrame => ({
  frameIndex: index,
  timestampMs: index * 2000,
  mimeType: 'image/png',
  buffer: Buffer.from('png'),
  frameSha256: hex(7000 + index),
  byteLength: 3,
  sourceRole: 'TRA_VIDEO',
  sourceVideoMediaId: mediaId(200 + index),
  sourceVideoFileName: `video-${index}.mp4`,
  sourceVideoContentHash: hex(8000 + index),
  approvedHumanSource: true,
  cacheKey: null,
});

describe('eligible human catalog v1', () => {
  it('includes ACTIVE approved-human records and excludes revoked/inactive records', () => {
    const active = approvedHuman(1);
    const inactive = approvedHuman(2, false);
    const catalog = buildEligibleHumanCatalog({ approvedHumans: [inactive, active] });

    expect(catalog.version).toBe(1);
    expect(catalog.candidates).toHaveLength(1);
    expect(catalog.candidates[0]).toMatchObject({
      kind: 'APPROVED_HUMAN_RECORD',
      sourceId: `approved-human:${active.id}`,
      recordId: active.id,
      approvalState: 'ACTIVE',
      approvedAt: active.approvedAt,
      updatedAt: active.updatedAt,
      pixelSha256: active.source.frames[0].approvedPngSha256,
    });
  });

  it('includes TRA_REFERENCE and never admits LAYOUT_REFERENCE as identity pixels', () => {
    const catalog = buildEligibleHumanCatalog({
      approvedHumans: [],
      requestedSources: [
        { role: 'LAYOUT_REFERENCE', mediaId: mediaId(1), sha256: hex(1) },
        { role: 'TRA_REFERENCE', mediaId: mediaId(2), sha256: hex(2) },
      ],
    });

    expect(catalog.candidates).toEqual([
      expect.objectContaining({
        kind: 'TRA_REFERENCE_IMAGE',
        sourceId: `tra-reference:${mediaId(2)}`,
        sourceRole: 'TRA_REFERENCE',
        sourceContentSha256: hex(2),
        approvalState: 'ROLE_ELIGIBLE',
      }),
    ]);
  });

  it('represents selected and approved TRA video frames with stable source and hash identity', () => {
    const selection = selectedFrame(1);
    const approved = approvedFrame(1);
    const catalog = buildEligibleHumanCatalog({
      approvedHumans: [], selectedVideoFrames: [selection], approvedVideoFrames: [approved],
    });

    expect(catalog.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'SELECTED_VIDEO_FRAME',
        sourceId: `video-frame:${selection.sourceVideoMediaId}:${selection.frames[0].libraryFrameId}`,
        sourceMediaId: selection.sourceVideoMediaId,
        sourceContentSha256: selection.sourceVideoContentHash,
        pixelSha256: selection.frames[0].approvedPngSha256,
        libraryFrameId: selection.frames[0].libraryFrameId,
      }),
      expect.objectContaining({
        kind: 'APPROVED_VIDEO_FRAME',
        sourceId: `approved-video-frame:${approved.sourceVideoMediaId}:${approved.frameSha256}`,
        sourceMediaId: approved.sourceVideoMediaId,
        sourceContentSha256: approved.sourceVideoContentHash,
        pixelSha256: approved.frameSha256,
        timestampMs: approved.timestampMs,
      }),
    ]));
  });

  it('canonically resolves duplicate approved-frame provenance independent of input order', () => {
    const canonical = approvedFrame(1);
    const duplicate: ApprovedTraVideoFrame = {
      ...canonical,
      frameIndex: canonical.frameIndex + 1,
      timestampMs: canonical.timestampMs + 500,
    };

    const forward = buildEligibleHumanCatalog({
      approvedHumans: [], approvedVideoFrames: [canonical, duplicate],
    });
    const reversed = buildEligibleHumanCatalog({
      approvedHumans: [], approvedVideoFrames: [duplicate, canonical],
    });

    expect(reversed).toEqual(forward);
    expect(forward.candidates).toHaveLength(1);
    expect(forward.candidates[0]).toMatchObject({
      kind: 'APPROVED_VIDEO_FRAME',
      frameIndex: canonical.frameIndex,
      timestampMs: canonical.timestampMs,
    });
  });

  it('does not truncate the complete eligible catalog at the legacy MAX 8 planner option bound', () => {
    const records = Array.from({ length: 12 }, (_, index) => approvedHuman(index + 1));
    const catalog = buildEligibleHumanCatalog({ approvedHumans: records });
    expect(catalog.candidates).toHaveLength(12);
  });

  it('orders deterministically regardless of input order', () => {
    const first = buildEligibleHumanCatalog({
      approvedHumans: [approvedHuman(3), approvedHuman(1)],
      selectedVideoFrames: [selectedFrame(2)],
      requestedSources: [{ role: 'TRA_REFERENCE', mediaId: mediaId(9), sha256: hex(9) }],
    });
    const second = buildEligibleHumanCatalog({
      approvedHumans: [approvedHuman(1), approvedHuman(3)],
      selectedVideoFrames: [selectedFrame(2)],
      requestedSources: [{ role: 'TRA_REFERENCE', mediaId: mediaId(9), sha256: hex(9) }],
    });
    expect(second).toEqual(first);
    expect(first.candidates.map(candidate => candidate.sourceId)).toEqual(
      [...first.candidates.map(candidate => candidate.sourceId)].sort(),
    );
  });

  it('deduplicates identical approved pixels without combining unrelated source identities', () => {
    const record = approvedHuman(1);
    const selection = selectedFrame(1);
    selection.sourceVideoMediaId = record.source.sourceVideoMediaId;
    selection.sourceVideoContentHash = record.source.sourceVideoContentHash;
    selection.frames[0].approvedPngSha256 = record.source.frames[0].approvedPngSha256;

    const catalog = buildEligibleHumanCatalog({ approvedHumans: [record], selectedVideoFrames: [selection] });
    expect(catalog.candidates).toHaveLength(1);
    expect(catalog.candidates[0]).toMatchObject({ kind: 'APPROVED_HUMAN_RECORD', recordId: record.id });
  });

  it('keeps the legacy no-human planning case valid as an empty catalog', () => {
    expect(buildEligibleHumanCatalog({ approvedHumans: [] })).toEqual({ version: 1, candidates: [] });
  });
});
