import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SelectedFrameGeneration } from '@/components/video-intelligence/selected-frame-generation';
import type { CreativeSourceVideoAsset } from '@/lib/media/types';
import type { VideoConceptSelection } from '@/lib/video/concept-selection';
import type { VideoFrameLibrary } from '@/lib/video/frame-library';

const frameId = `video-frame:${'a'.repeat(64)}`;
const media = { id: `media_${'b'.repeat(32)}`, fileName: 'source.mp4', originalName: 'source.mp4', mimeType: 'video/mp4', mediaType: 'VIDEO', size: 10, url: '/source.mp4' } as CreativeSourceVideoAsset;
const library = { id: `video-library:${'c'.repeat(64)}`, sourceVideoContentHash: 'd'.repeat(64), representativeFrames: [{ id: frameId, timestampMs: 500, thumbnailDataUrl: 'data:image/jpeg;base64,AA==' }] } as VideoFrameLibrary;
const selection = { concept: 'Clear next steps', frames: [{ frameId, reason: 'The visible source frame supports a clear hierarchy.' }] } as VideoConceptSelection;

describe('SelectedFrameGeneration', () => {
  it('renders checked source-frame controls and the cost-labelled two-variation action', () => {
    const html = renderToStaticMarkup(createElement(SelectedFrameGeneration, { media, library, selection }));
    expect(html).toContain('Choose 1–3 source frames');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('Generate 2 creatives from checked frames (uses API)');
  });
});
