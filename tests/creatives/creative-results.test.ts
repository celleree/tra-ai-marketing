import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CreativeResults } from '@/components/creative-generator/creative-results';
import type { GeneratedCreative } from '@/lib/creatives/generated';

const creative = {
  id: 'creative_abc',
  index: 2,
  category: 'customer-problems' as const,
  format: 'direct-response' as const,
  image: {
    id: `media_${'a'.repeat(32)}`,
    fileName: `media_${'a'.repeat(32)}.png`,
    originalName: 'creative.png',
    mimeType: 'image/png' as const,
    size: 12,
    url: `/api/media/files/media_${'a'.repeat(32)}.png`,
  },
  copy: { headline: 'Headline', primaryText: 'Primary', description: 'Description' },
};

describe('CreativeResults progressive delivery state', () => {
  it('shows completed cards, failed slots, and remaining loading slots while generating', () => {
    const html = renderToStaticMarkup(
      createElement(CreativeResults, {
        creatives: [creative],
        generating: true,
        requestedCount: 3,
        generationComplete: false,
        generationFailures: { 1: 'Creative 1 could not be generated.' },
      })
    );

    expect(html).toContain('Building your creative variations');
    expect(html).toContain('Headline');
    expect(html).toContain('Creative 1 could not be completed.');
    expect(html).toContain('aria-busy="true"');
  });

  it('keeps Meta actions disabled until terminal completion', () => {
    const incomplete = renderToStaticMarkup(
      createElement(CreativeResults, {
        creatives: [creative],
        requestedCount: 2,
        generationComplete: false,
      })
    );
    const complete = renderToStaticMarkup(
      createElement(CreativeResults, {
        creatives: [creative],
        requestedCount: 2,
        generationComplete: true,
      })
    );

    expect(incomplete).toMatch(/<button[^>]*disabled[^>]*>Select all/);
    expect(complete).toContain('Select all');
    expect(complete).not.toMatch(/<button[^>]*disabled[^>]*>Select all/);
  });

  it('shows Edit and a fallback notice for an editable generated creative', () => {
    const editable = {
      ...creative,
      placement: 'SQUARE_1_1',
      identity: {},
      planning: {},
      generationProvenance: {
        imageGeneration: {
          routing: { fallbackUsed: true },
        },
      },
    } as unknown as GeneratedCreative;
    const html = renderToStaticMarkup(createElement(CreativeResults, {
      creatives: [editable],
      generationComplete: true,
    }));
    expect(html).toMatch(/<button[^>]*>Edit<\/button>/);
    expect(html).toContain('A compatible fallback image model was used.');
    expect(html).not.toContain('Image model');
  });
});
