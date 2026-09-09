import { MAX_REPRESENTATIVE_VIDEO_FRAMES } from '@/lib/video/types';

export const selectRepresentativeVideoTimestamps = (durationMs: number) => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];

  const fractions =
    durationMs < 1_500
      ? [0]
      : durationMs < 5_000
        ? [0, 0.5, 0.9]
        : [0, 0.2, 0.4, 0.6, 0.8, 0.95];
  const latestTimestamp = Math.max(0, Math.floor(durationMs - 50));

  return Array.from(
    new Set(
      fractions.map((fraction) =>
        Math.min(latestTimestamp, Math.max(0, Math.round(durationMs * fraction)))
      )
    )
  ).slice(0, MAX_REPRESENTATIVE_VIDEO_FRAMES);
};
