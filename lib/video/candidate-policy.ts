import type { VideoFrameCandidatePolicy } from '@/lib/video/candidate-types';

export const DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY: VideoFrameCandidatePolicy = {
  targetIntervalFps: 3,
  maxIntervalCandidates: 360,
  maxTotalCandidates: 480,
  maxWidth: 1280,
  imageFormat: 'jpeg',
  jpegQuality: 85,
};

export const validateVideoFrameCandidatePolicy = (
  policy: VideoFrameCandidatePolicy
) => {
  if (!Number.isFinite(policy.targetIntervalFps) || policy.targetIntervalFps <= 0) {
    throw new Error('Video candidate targetIntervalFps must be a positive number.');
  }
  if (!Number.isInteger(policy.maxIntervalCandidates) || policy.maxIntervalCandidates < 1) {
    throw new Error('Video candidate maxIntervalCandidates must be a positive integer.');
  }
  if (!Number.isInteger(policy.maxTotalCandidates) || policy.maxTotalCandidates < 1) {
    throw new Error('Video candidate maxTotalCandidates must be a positive integer.');
  }
  if (policy.maxTotalCandidates < policy.maxIntervalCandidates) {
    throw new Error('Video candidate maxTotalCandidates must be at least maxIntervalCandidates.');
  }
  if (!Number.isInteger(policy.maxWidth) || policy.maxWidth < 1) {
    throw new Error('Video candidate maxWidth must be a positive integer.');
  }
  if (policy.imageFormat !== 'jpeg') {
    throw new Error('Video candidates must use JPEG during temporary extraction.');
  }
  if (!Number.isInteger(policy.jpegQuality) || policy.jpegQuality < 1 || policy.jpegQuality > 100) {
    throw new Error('Video candidate jpegQuality must be an integer from 1 to 100.');
  }
};

export const getEffectiveIntervalFps = (
  durationMs: number,
  policy: VideoFrameCandidatePolicy = DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY
) => {
  validateVideoFrameCandidatePolicy(policy);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('Video duration must be a positive number.');
  }

  const durationSeconds = durationMs / 1000;
  return Math.min(
    policy.targetIntervalFps,
    policy.maxIntervalCandidates / durationSeconds
  );
};

export const estimateIntervalCandidateCount = (
  durationMs: number,
  policy: VideoFrameCandidatePolicy = DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY
) => {
  const effectiveIntervalFps = getEffectiveIntervalFps(durationMs, policy);
  return Math.min(
    policy.maxIntervalCandidates,
    Math.max(1, Math.ceil((durationMs / 1000) * effectiveIntervalFps))
  );
};
