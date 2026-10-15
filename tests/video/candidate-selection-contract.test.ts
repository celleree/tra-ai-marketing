import { describe, expect, it } from 'vitest';
import { parseGenerateVideoFrameSelection, parseGeneratedVideoFrameSelection,
  videoCandidateFrameId } from '@/lib/video/generation-selection-contract';

const sourceHash = 'a'.repeat(64);
const frameHash = 'b'.repeat(64);
const frameId = videoCandidateFrameId(sourceHash, 2_000, frameHash);
const representativeFrameId = `video-frame:${'c'.repeat(64)}`;
const selection = () => ({ version: 3, libraryId: `video-library:${'d'.repeat(64)}`,
  sourceVideoMediaId: `media_${'e'.repeat(32)}`, sourceVideoContentHash: sourceHash,
  librarySha256: 'f'.repeat(64), frameIds: [frameId],
  candidateBindings: [{ frameId, representativeFrameId, candidateIndex: 7, timestampMs: 2_000, frameSha256: frameHash }],
  sourceOverlays: [{ version: 2, status: 'CLEAN' }] });

describe('candidate-addressable video selection contract', () => {
  it('preserves exact candidate, representative, source, and library identity', () => {
    expect(parseGenerateVideoFrameSelection(selection())).toEqual(selection());
    const generated = { libraryId: selection().libraryId, sourceVideoMediaId: selection().sourceVideoMediaId,
      sourceVideoContentHash: sourceHash, librarySha256: selection().librarySha256,
      frames: [{ frameIndex: 0, libraryFrameId: frameId, representativeFrameId,
        candidateIndex: 7, candidateFrameSha256: frameHash, timestampMs: 2_000, approvedPngSha256: '1'.repeat(64) }] };
    expect(parseGeneratedVideoFrameSelection(generated)).toEqual(generated);
  });

  it('rejects mismatched candidate identity and unsafe overlay before generation', () => {
    const base = selection();
    expect(parseGenerateVideoFrameSelection({ ...base, candidateBindings: [{ ...base.candidateBindings[0], timestampMs: 2_001 }] })).toBeNull();
    expect(parseGenerateVideoFrameSelection({ ...base, frameIds: [representativeFrameId] })).toBeNull();
    expect(parseGenerateVideoFrameSelection({ ...base, sourceOverlays: [{ version: 2, status: 'UNSAFE' }] })).toBeNull();
    expect(parseGenerateVideoFrameSelection({ ...base, librarySha256: 'invalid' })).toBeNull();
  });

  it('keeps existing representative v2 selections readable', () => {
    const representative = { version: 2, libraryId: selection().libraryId,
      sourceVideoContentHash: sourceHash, frameIds: [representativeFrameId],
      sourceOverlays: [{ version: 2, status: 'EDGE_CROP', edge: 'BOTTOM', removePermille: 100, overlayDepthPermille: 80 }] };
    expect(parseGenerateVideoFrameSelection(representative)).toEqual(representative);
  });
});
