import { createHash } from 'node:crypto';
import type { TemporaryVideoFrameCandidateSet } from '@/lib/video/candidate-types';
import type { analyzeTemporaryVideoCandidates } from '@/lib/video/candidate-technical-selection';
import { transcriptAtTimestamp, type VideoTranscript } from '@/lib/video/transcript';
import { VIDEO_CONTENT_TOPICS, VIDEO_SCENE_TYPES, type observeTemporaryVideoFrame } from '@/lib/video/visual-observation';

type TechnicalSelection = Awaited<ReturnType<typeof analyzeTemporaryVideoCandidates>>;
type FrameObservationResult = Awaited<ReturnType<typeof observeTemporaryVideoFrame>>;
type TechnicalCandidate = TechnicalSelection['candidates'][number];

export interface VideoFrameLibrary {
  version: 1;
  id: string;
  providerEligible: false;
  evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION';
  sourceVideoMediaId: string;
  sourceVideoContentHash: string;
  durationMs: number;
  transcript: Pick<VideoTranscript, 'version' | 'model' | 'language' | 'segments'>;
  candidates: Array<{
    candidateIndex: number; timestampMs: number; width: number; height: number;
    extractionReasons: readonly string[]; frameSha256: string; technical: TechnicalCandidate['technical'];
  }>;
  representativeFrames: Array<{
    id: string; candidateIndexes: number[]; candidateIndex: number; timestampMs: number;
    frameSha256: string; qualityScore: number; thumbnailDataUrl: string;
    evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION'; observation: FrameObservationResult['observation'];
    transcriptSegments: VideoTranscript['segments'];
  }>;
  semanticGroups: {
    sceneTypes: Array<{ sceneType: FrameObservationResult['observation']['sceneType']; representativeFrameIds: string[] }>;
    topics: Array<{ topic: FrameObservationResult['observation']['topics'][number]; representativeFrameIds: string[] }>;
  };
}

const sourceMatches = (value: { sourceVideoMediaId: string; sourceVideoContentHash: string }, set: TemporaryVideoFrameCandidateSet, name: string) => {
  if (value.sourceVideoMediaId !== set.sourceVideoMediaId || value.sourceVideoContentHash !== set.sourceVideoContentHash) {
    throw new Error(`${name} source provenance does not match the candidate set.`);
  }
};

const uniqueByIndex = <T extends { candidateIndex: number }>(values: readonly T[], name: string) => {
  const result = new Map<number, T>();
  for (const value of values) {
    if (result.has(value.candidateIndex)) throw new Error(`Duplicate ${name} for candidate ${value.candidateIndex}.`);
    result.set(value.candidateIndex, value);
  }
  return result;
};

const frameId = (hash: string, candidateIndex: number) => `video-frame:${hash}:${candidateIndex}`;

export const assembleVideoFrameLibrary = (
  set: TemporaryVideoFrameCandidateSet,
  technicalSelection: TechnicalSelection,
  transcript: VideoTranscript,
  observations: readonly FrameObservationResult[],
  thumbnails: ReadonlyMap<number, string>
): VideoFrameLibrary => {
  sourceMatches(technicalSelection, set, 'Technical selection');
  sourceMatches(transcript, set, 'Transcript');
  const candidates = uniqueByIndex(set.candidates, 'candidate');
  for (const candidate of candidates.values()) sourceMatches(candidate, set, 'Candidate');
  const technical = uniqueByIndex(technicalSelection.candidates, 'technical analysis');
  if (technical.size !== candidates.size) throw new Error('Technical analysis must cover every candidate exactly once.');
  for (const [index, entry] of technical) {
    const candidate = candidates.get(index);
    if (!candidate || entry.frameSha256 !== candidate.frameSha256) throw new Error(`Technical analysis frame mismatch for candidate ${index}.`);
  }
  const grouped = new Set<number>();
  for (const group of technicalSelection.groups) {
    if (!group.candidateIndexes.includes(group.representativeIndex)) throw new Error('Technical group representative must be a member.');
    for (const index of group.candidateIndexes) {
      if (!candidates.has(index) || grouped.has(index)) throw new Error(`Invalid technical group membership for candidate ${index}.`);
      grouped.add(index);
    }
  }
  if (grouped.size !== candidates.size) throw new Error('Technical groups must retain every candidate.');
  const representatives = new Set(technicalSelection.groups.map((group) => group.representativeIndex));
  if (representatives.size !== technicalSelection.groups.length || thumbnails.size !== representatives.size) {
    throw new Error('Every representative requires exactly one thumbnail.');
  }
  for (const [index, dataUrl] of thumbnails) {
    if (!representatives.has(index) || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]*={0,2}$/.test(dataUrl)) {
      throw new Error(`Invalid representative thumbnail for candidate ${index}.`);
    }
  }
  const observed = uniqueByIndex(observations, 'observation');
  if (observed.size !== representatives.size) throw new Error('Every representative requires exactly one observation.');
  for (const [index, result] of observed) {
    const candidate = candidates.get(index);
    sourceMatches(result, set, 'Observation');
    if (!representatives.has(index) || !candidate || result.timestampMs !== candidate.timestampMs || result.frameSha256 !== candidate.frameSha256) {
      throw new Error(`Observation frame mismatch for candidate ${index}.`);
    }
    if (!VIDEO_SCENE_TYPES.includes(result.observation.sceneType) || result.observation.topics.some((topic) => !VIDEO_CONTENT_TOPICS.includes(topic))) {
      throw new Error(`Observation uses uncontrolled semantic values for candidate ${index}.`);
    }
  }
  const representativeFrames = technicalSelection.groups.map((group) => {
    const candidate = candidates.get(group.representativeIndex)!;
    const observation = observed.get(group.representativeIndex)!;
    return { id: frameId(set.sourceVideoContentHash, candidate.candidateIndex), candidateIndexes: [...group.candidateIndexes],
      candidateIndex: candidate.candidateIndex, timestampMs: candidate.timestampMs, frameSha256: candidate.frameSha256,
      qualityScore: technical.get(candidate.candidateIndex)!.technical.qualityScore, thumbnailDataUrl: thumbnails.get(candidate.candidateIndex)!,
      evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION' as const, observation: observation.observation,
      transcriptSegments: transcriptAtTimestamp(transcript, candidate.timestampMs) };
  }).sort((a, b) => a.timestampMs - b.timestampMs || a.candidateIndex - b.candidateIndex);
  const sceneTypes = VIDEO_SCENE_TYPES.flatMap((sceneType) => {
    const representativeFrameIds = representativeFrames.filter((frame) => frame.observation.sceneType === sceneType).map((frame) => frame.id);
    return representativeFrameIds.length ? [{ sceneType, representativeFrameIds }] : [];
  });
  const topics = VIDEO_CONTENT_TOPICS.flatMap((topic) => {
    const representativeFrameIds = representativeFrames.filter((frame) => frame.observation.topics.includes(topic)).map((frame) => frame.id);
    return representativeFrameIds.length ? [{ topic, representativeFrameIds }] : [];
  });
  return {
    version: 1, id: `video-library:${createHash('sha256').update(`${set.sourceVideoMediaId}:${set.sourceVideoContentHash}`).digest('hex')}`,
    providerEligible: false, evidenceStatus: 'UNVERIFIED_MODEL_OBSERVATION', sourceVideoMediaId: set.sourceVideoMediaId,
    sourceVideoContentHash: set.sourceVideoContentHash, durationMs: set.durationMs,
    transcript: { version: transcript.version, model: transcript.model, language: transcript.language, segments: transcript.segments },
    candidates: [...candidates.values()].sort((a, b) => a.timestampMs - b.timestampMs || a.candidateIndex - b.candidateIndex).map((candidate) => ({
      candidateIndex: candidate.candidateIndex, timestampMs: candidate.timestampMs, width: candidate.width, height: candidate.height,
      extractionReasons: candidate.extractionReasons, frameSha256: candidate.frameSha256, technical: technical.get(candidate.candidateIndex)!.technical,
    })),
    representativeFrames,
    semanticGroups: { sceneTypes, topics },
  };
};
