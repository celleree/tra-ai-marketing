// Limit typed source assets, not the separate brand logo or selected video frames.
export const MAX_CREATIVE_SOURCE_ASSETS = 10;

export const getCreativeSourceCountError = (count: number): string =>
  count > MAX_CREATIVE_SOURCE_ASSETS
    ? `Attach at most ${MAX_CREATIVE_SOURCE_ASSETS} source assets. Remove sources and try again.`
    : '';
