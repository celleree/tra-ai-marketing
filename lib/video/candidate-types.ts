export type VideoFrameCandidateExtractionReason =
  | 'INTERVAL'
  | 'SCENE_CHANGE';

export type NonEmptyVideoFrameCandidateExtractionReasons = readonly [
  VideoFrameCandidateExtractionReason,
  ...VideoFrameCandidateExtractionReason[],
];

export interface VideoFrameCandidatePolicy {
  targetIntervalFps: number;
  maxIntervalCandidates: number;
  maxTotalCandidates: number;
  maxWidth: number;
  imageFormat: 'jpeg';
  jpegQuality: number;
}

export interface TemporaryVideoFrameCandidate {
  candidateIndex: number;
  timestampMs: number;
  sourceRole: 'TRA_VIDEO';
  sourceVideoMediaId: string;
  sourceVideoFileName: string;
  sourceVideoContentHash: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  byteLength: number;
  frameSha256: string;
  extractionReasons: NonEmptyVideoFrameCandidateExtractionReasons;
  temporaryPath: string;
  lifecycle: 'TEMPORARY';
  providerEligible: false;
}

export type VideoFrameAnalysisCandidate = Omit<
  TemporaryVideoFrameCandidate,
  'temporaryPath' | 'lifecycle'
>;

export interface TemporaryVideoFrameCandidateSet {
  sourceVideoMediaId: string;
  sourceVideoFileName: string;
  sourceVideoContentHash: string;
  durationMs: number;
  policy: VideoFrameCandidatePolicy;
  effectiveIntervalFps: number;
  candidates: TemporaryVideoFrameCandidate[];
  temporarySourceVideoPath: string;
  temporaryDirectories: readonly string[];
}

export interface TemporaryVideoFrameCandidateMaterialization {
  candidates: TemporaryVideoFrameCandidate[];
  temporaryDirectory: string | null;
}
