export type SourceOverlayDecision =
  | { version: 2; status: 'CLEAN' }
  | { version: 2; status: 'EDGE_CROP'; edge: 'TOP' | 'BOTTOM' | 'LEFT' | 'RIGHT'; removePermille: number; overlayDepthPermille: number }
  | { version: 2; status: 'UNSAFE' };
export type SourceCrop = { left: number; top: number; width: number; height: number };

export const parseSourceOverlayDecision = (value: unknown): SourceOverlayDecision | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.version !== 2) return null;
  if ((item.status === 'CLEAN' || item.status === 'UNSAFE') && Object.keys(item).length === 2) {
    return item as SourceOverlayDecision;
  }
  if (item.status !== 'EDGE_CROP' || Object.keys(item).length !== 5
    || !['TOP', 'BOTTOM', 'LEFT', 'RIGHT'].includes(String(item.edge))
    || !Number.isSafeInteger(item.removePermille) || !Number.isSafeInteger(item.overlayDepthPermille)
    || (item.removePermille as number) < 1 || (item.removePermille as number) > 450
    || (item.overlayDepthPermille as number) < 1
    || (item.overlayDepthPermille as number) > (item.removePermille as number)) return null;
  return item as SourceOverlayDecision;
};

/** Provider wire schema requires geometry even for UNSAFE; normalize rejection, never approval. */
export const parseProviderSourceOverlayDecision = (value: unknown): SourceOverlayDecision | null => {
  const canonical = parseSourceOverlayDecision(value);
  if (canonical) return canonical;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 4 || !['CLEAN', 'EDGE_CROP', 'UNSAFE'].includes(String(item.status))
    || !['NONE', 'TOP', 'BOTTOM', 'LEFT', 'RIGHT'].includes(String(item.edge))
    || !Number.isSafeInteger(item.removePermille) || !Number.isSafeInteger(item.overlayDepthPermille)
    || (item.removePermille as number) < 0 || (item.removePermille as number) > 450
    || (item.overlayDepthPermille as number) < 0 || (item.overlayDepthPermille as number) > 450) return null;
  if (item.status === 'UNSAFE') return { version: 2, status: 'UNSAFE' };
  if (item.status === 'CLEAN') return item.edge === 'NONE' && item.removePermille === 0 && item.overlayDepthPermille === 0
    ? { version: 2, status: 'CLEAN' } : null;
  return parseSourceOverlayDecision({ version: 2, ...item });
};
