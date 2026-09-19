import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { contiguousVideoPassageRange, VideoPassageCandidateFeedback, VideoPassageCandidateSelection, videoPassageCandidatePayload } from '@/components/video-intelligence/video-intelligence-studio';

const locator = { version: 1 as const, sourceVideoMediaId: 'media', sourceVideoContentHash: 'a'.repeat(64), analyzerFingerprintSha256: 'b'.repeat(64) };
const segments = [{ segmentIndex: 4, startMs: 1_000, endMs: 2_000, text: 'First exact transcript segment.' }, { segmentIndex: 9, startMs: 2_100, endMs: 3_500, text: 'Second exact transcript segment.' }];

describe('Video passage candidate UI', () => {
  it('renders accessible contiguous transcript-range controls and the exact selected passage', () => {
    const html = renderToStaticMarkup(createElement(VideoPassageCandidateSelection, { locator, segments }));
    expect(html).toContain('aria-label="Create video passage candidate"'); expect(html).toContain('aria-label="Start transcript segment"'); expect(html).toContain('aria-label="End transcript segment"');
    expect(html).toContain('Selected passage: 00:01.000–00:02.000'); expect(html).toContain('First exact transcript segment.'); expect(html).toContain('Create Proof candidate');
  });

  it('normalizes selection to a contiguous increasing index range', () => {
    expect(contiguousVideoPassageRange(3, 1)).toEqual({ start: 3, end: 3 });
    expect(contiguousVideoPassageRange(1, 3)).toEqual({ start: 1, end: 3 });
  });

  it('posts only the locator and transcript range indexes', () => {
    expect(videoPassageCandidatePayload(locator, 0, 1)).toEqual({ locator, startSegmentIndex: 0, endSegmentIndex: 1 });
    expect(Object.keys(videoPassageCandidatePayload(locator, 0, 1))).toEqual(['locator', 'startSegmentIndex', 'endSegmentIndex']);
  });

  it('announces API errors accessibly', () => {
    const html = renderToStaticMarkup(createElement(VideoPassageCandidateFeedback, { message: 'Video passage candidate request is invalid.', failed: true }));
    expect(html).toContain('role="alert"'); expect(html).toContain('aria-live="polite"');
  });
});
