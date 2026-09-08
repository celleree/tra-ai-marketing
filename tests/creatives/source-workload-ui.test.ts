import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CreativeComposer } from '@/components/creative-generator/creative-composer';
import { MAX_CREATIVE_SOURCE_ASSETS } from '@/lib/media/source-limits';
import type { CreativeSourceAsset } from '@/lib/media/types';

const render = (count: number, allowMultipleSources = true) => {
  const sourceAssets: CreativeSourceAsset[] = Array.from({ length: count }, (_, index) => ({
    role: 'TRA_REFERENCE',
    media: {
      id: `media_${index.toString(16).padStart(32, '0')}`,
      fileName: `${index}.png`, originalName: `${index}.png`,
      mimeType: 'image/png', mediaType: 'IMAGE', size: 100, url: `/source-${index}.png`,
    },
  }));
  return renderToStaticMarkup(createElement(CreativeComposer, {
    value: '', onChange: () => {}, onUploadStart: () => {}, onUploaded: () => {},
    sourceAssets, onSourceRoleChange: () => {}, onSourceRemoved: () => {},
    allowMultipleSources, variationCount: 2, onVariationCountChange: () => {},
    onSubmit: () => {}, ready: false, generating: false,
  }));
};
const addButton = (html: string) => html.match(/<button[^>]*aria-label="Add creative source assets"[^>]*>/)?.[0];

describe('composer source-limit controls', () => {
  it('leaves attachment controls available below the shared limit', () => {
    const button = addButton(render(MAX_CREATIVE_SOURCE_ASSETS - 1));
    expect(button).toBeDefined();
    expect(button).not.toContain('disabled');
  });

  it('disables additions and explains how to recover at the shared limit', () => {
    const html = render(MAX_CREATIVE_SOURCE_ASSETS);
    expect(addButton(html)).toContain('disabled');
    expect(html).toContain(`Maximum of ${MAX_CREATIVE_SOURCE_ASSETS} sources attached.`);
    expect(html.match(/<input[^>]*type="file"[^>]*>/)?.[0]).toContain('disabled');
  });

  it('preserves single-source replacement mode', () => {
    const button = addButton(render(1, false));
    expect(button).toBeDefined();
    expect(button).not.toContain('disabled');
  });
});
