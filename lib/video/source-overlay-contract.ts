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
