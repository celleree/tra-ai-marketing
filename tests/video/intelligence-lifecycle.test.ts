import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { isStructurallyValidPng } from '@/lib/video/frame-cache';
import { loadVideoIntelligenceLibrary } from '@/lib/video/intelligence-finalization-runner';
import { readVideoIntelligenceJob } from '@/lib/video/intelligence-job-store';
import { loadVideoIntelligencePreparation } from '@/lib/video/intelligence-preparation-loader';
import { executeVideoIntelligenceStep, readVideoIntelligenceSource, resolveVideoIntelligenceJobLocator } from '@/lib/video/intelligence-service';
import { LocalVideoIntelligenceStorage } from '@/lib/video/intelligence-storage';
import { getApprovedPreparedSelectedTraVideoFrames } from '@/lib/video/prepared-selected-frames';
import { selectVideoFramesWithCache } from '@/lib/video/selection-cache';
import { REAL_SCENE_CHANGE_MP4 } from '@/tests/fixtures/video-candidate-scene';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const mediaId = `media_${'d'.repeat(32)}`;
const fileName = `${mediaId}.mp4`;
const source: HydratedTraVideoSource = {
  role: 'TRA_VIDEO', media: { id: mediaId, fileName, mimeType: 'video/mp4', mediaType: 'VIDEO',
    size: REAL_SCENE_CHANGE_MP4.length, url: `/api/media/files/${fileName}` },
  stored: { fileName, buffer: REAL_SCENE_CHANGE_MP4, mimeType: 'video/mp4', mediaType: 'VIDEO' },
};
const output = (value: unknown) => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
afterEach(() => vi.unstubAllEnvs());

describe('persisted video intelligence lifecycle', () => {
  it('prepares a real MP4, resumes bounded jobs, reopens artifacts and reuses selection before fresh approved PNG extraction', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    const directory = await mkdtemp(path.join(tmpdir(), 'tra-intelligence-lifecycle-'));
    try {
      const storage = new LocalVideoIntelligenceStorage(path.join(directory, 'artifacts'));
      const request = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        if (String(url).endsWith('/audio/transcriptions')) return Response.json({ language: 'en', segments: [{ start: 0, end: 1, text: 'Synthetic source speech.' }] });
        return output({ sceneType: 'OTHER', summary: 'Synthetic fixture frame.', composition: 'Full frame.', visibleText: [], topics: ['other'], uncertainties: [] });
      });
      const deps = { storage, request, now: () => 1_000, deadlineAtMs: 296_000, hydrateSource: async () => source };
      expect((await readVideoIntelligenceSource(mediaId, deps)).status).toBeNull();
      let status = await executeVideoIntelligenceStep({ action: 'START', mediaId }, deps);
      expect(status.phase).toBe('TRANSCRIBING');
      expect(request).not.toHaveBeenCalled();
      const locator = status.locator;
      // A new storage instance represents reopening after the original request/process ended.
      const reopened = new LocalVideoIntelligenceStorage(path.join(directory, 'artifacts'));
      expect((await readVideoIntelligenceSource(mediaId, { ...deps, storage: reopened })).status?.phase).toBe('TRANSCRIBING');
      for (let unit = 0; unit < 10 && status.phase !== 'COMPLETE'; unit += 1) {
        status = await executeVideoIntelligenceStep({ action: 'ADVANCE', locator }, { ...deps, storage: reopened });
        expect(['FAILED', 'RETRY_REQUIRED']).not.toContain(status.phase);
        expect(status.busy).toBe(false);
      }
      expect(status.phase).toBe('COMPLETE');
      const identity = resolveVideoIntelligenceJobLocator(locator);
      const complete = (await readVideoIntelligenceJob(identity, { storage: reopened }))!.job;
      const library = await loadVideoIntelligenceLibrary(identity, complete.result!, { storage: reopened });
      expect(request.mock.calls.filter(([url]) => String(url).endsWith('/audio/transcriptions'))).toHaveLength(0);
      expect(library.analysisModels.transcription).toBeNull();
      expect(request.mock.calls.filter(([url]) => String(url).endsWith('/responses'))).toHaveLength(library.representativeFrames.length);
      const paidCalls = request.mock.calls.length;
      expect((await executeVideoIntelligenceStep({ action: 'START', mediaId }, deps)).phase).toBe('COMPLETE');
      expect((await readVideoIntelligenceSource(mediaId, deps)).status?.phase).toBe('COMPLETE');
      expect(request).toHaveBeenCalledTimes(paidCalls);
      expect(library.sourceVideoContentHash).toBe(sha(source.stored.buffer));
      expect(library.providerEligible).toBe(false);
      expect(library.representativeFrames.every((frame) => frame.evidenceStatus === 'UNVERIFIED_MODEL_OBSERVATION')).toBe(true);

      const frameIds = library.representativeFrames.slice(0, 3).map((frame) => frame.id).reverse();
      const selector = vi.fn<typeof fetch>().mockImplementation(async () => output({ frames: frameIds.map((frameId) => ({ frameId, reason: 'Visible synthetic scene.' })) }));
      const selectionDeps = { storage: reopened, model: identity.analyzerFingerprint.visionModel, request: selector, now: deps.now, deadlineAtMs: deps.deadlineAtMs };
      const selected = await selectVideoFramesWithCache(library, complete.result!.sha256, 'fixture concept', selectionDeps);
      expect(selected).toMatchObject({ status: 'COMPLETE', selection: { providerEligible: false, sourceVideoContentHash: sha(source.stored.buffer) } });
      expect(await selectVideoFramesWithCache(library, complete.result!.sha256, ' fixture concept ', selectionDeps)).toEqual(selected);
      expect(selector).toHaveBeenCalledTimes(1);
      const preparation = complete.preparation!;
      const loaded = await loadVideoIntelligencePreparation({ manifestKey: preparation.manifestKey, manifestSha256: preparation.manifestSha256,
        expectedSourceVideoMediaId: mediaId, expectedSourceVideoContentHash: locator.sourceVideoContentHash,
        expectedAnalyzerFingerprintSha256: locator.analyzerFingerprintSha256 }, { storage: reopened });
      const approved = await getApprovedPreparedSelectedTraVideoFrames(source, library, frameIds, loaded.manifest, { temporaryRoot: directory });
      expect(approved.selectionProvenance.map((frame) => frame.libraryFrameId)).toEqual(frameIds);
      for (const [index, frame] of approved.frames.entries()) {
        expect(isStructurallyValidPng(frame.buffer)).toBe(true);
        expect(frame.approvedHumanSource).toBe(true);
        expect(frame.sourceVideoContentHash).toBe(locator.sourceVideoContentHash);
        expect(frame.frameSha256).toBe(sha(frame.buffer));
        expect(approved.selectionProvenance[index].approvedPngSha256).toBe(frame.frameSha256);
      }
      expect(await readdir(directory)).toEqual(['artifacts']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
