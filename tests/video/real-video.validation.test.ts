import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { validateStoredMedia } from '@/lib/media/storage';
import type { HydratedTraVideoSource } from '@/lib/video/candidate-extractor';
import { withTemporaryTraVideoFrameCandidates } from '@/lib/video/candidate-lifecycle';
import { DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY } from '@/lib/video/candidate-policy';
import { runFfmpeg } from '@/lib/video/ffmpeg';
import { analyzeTemporaryVideoCandidates } from '@/lib/video/candidate-technical-selection';
import { transcribeTraVideo, transcriptAtTimestamp } from '@/lib/video/transcript';

// Opt-in local validation; real customer media and generated reports stay out of Git.
// Set TRA_VIDEO_VALIDATION_INPUT, then npm test -- tests/video/real-video.validation.test.ts
const input = process.env.TRA_VIDEO_VALIDATION_INPUT;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
);

it.skipIf(!input)('validates a local TRA video and writes an inspectable extraction report', async () => {
  const buffer = await readFile(path.resolve(input!));
  const sourceHash = sha256(buffer);
  const fileName = path.basename(input!);
  const stored = { fileName, buffer, mimeType: 'video/mp4' as const, mediaType: 'VIDEO' as const };
  validateStoredMedia(stored);
  const source: HydratedTraVideoSource = {
    role: 'TRA_VIDEO',
    media: {
      id: `media_${sourceHash.slice(0, 32)}`, fileName, mimeType: 'video/mp4',
      mediaType: 'VIDEO', size: buffer.length, url: '',
    },
    stored,
  };
  const expectedScenes: unknown = JSON.parse(process.env.TRA_VIDEO_VALIDATION_SCENES || '[]');
  if (!Array.isArray(expectedScenes) || expectedScenes.some((window) =>
    !Array.isArray(window) || window.length !== 2 ||
    !window.every((value) => Number.isSafeInteger(value) && value >= 0) || window[0] > window[1]
  )) throw new Error('TRA_VIDEO_VALIDATION_SCENES must be an array of [startMs, endMs] windows.');
  const sceneWindows = expectedScenes as number[][];
  const runtime = (await runFfmpeg(['-version'])).stdout.toString().split(/\r?\n/)[0];
  const runtimePath = process.env.FFMPEG_BIN?.trim() || path.join(
    process.cwd(), '.runtime', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  );
  const runtimeSha256 = sha256(await readFile(runtimePath));
  const output = path.join(process.cwd(), '.runtime', 'video-validation', `${Date.now()}-${sourceHash.slice(0, 12)}`);
  const ownedPaths: string[] = [];
  const gallery: string[] = [];
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const report = await withTemporaryTraVideoFrameCandidates(source, async (set) => {
    ownedPaths.push(set.temporarySourceVideoPath, ...set.temporaryDirectories,
      ...set.candidates.map((candidate) => candidate.temporaryPath));
    const interval = set.candidates.filter((candidate) => candidate.extractionReasons.includes('INTERVAL'));
    const scenes = set.candidates.filter((candidate) => candidate.extractionReasons.includes('SCENE_CHANGE'));
    const periodMs = 1000 / set.effectiveIntervalFps;
    const gapsMs = interval.slice(1).map((candidate, index) => candidate.timestampMs - interval[index].timestampMs);
    expect(interval.length).toBeGreaterThan(0);
    expect(interval.length).toBeLessThanOrEqual(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY.maxIntervalCandidates);
    expect(set.candidates.length).toBeLessThanOrEqual(DEFAULT_VIDEO_FRAME_CANDIDATE_POLICY.maxTotalCandidates);
    expect(interval[0].timestampMs).toBeLessThanOrEqual(periodMs + 2);
    expect(set.durationMs - interval.at(-1)!.timestampMs).toBeLessThanOrEqual(periodMs + 100);
    for (const gap of gapsMs) expect(Math.abs(gap - periodMs)).toBeLessThanOrEqual(2);
    for (const [startMs, endMs] of sceneWindows) {
      expect(endMs).toBeLessThan(set.durationMs);
      expect(scenes.some((candidate) => candidate.timestampMs >= startMs && candidate.timestampMs <= endMs),
        `Missing scene-change candidate in ${startMs}-${endMs}ms`).toBe(true);
    }
    const candidates = [];
    const transcript = process.env.TRA_VIDEO_VALIDATION_TRANSCRIPT === '1'
      ? await transcribeTraVideo(source, set.durationMs) : null;
    const technicalSelection = process.env.TRA_VIDEO_VALIDATION_TECHNICAL === '1'
      ? await analyzeTemporaryVideoCandidates(set) : null;
    for (const candidate of set.candidates) {
      const bytes = await readFile(candidate.temporaryPath);
      expect(sha256(bytes)).toBe(candidate.frameSha256);
      expect(bytes.length).toBe(candidate.byteLength);
      expect(candidate.sourceVideoContentHash).toBe(sourceHash);
      expect(candidate.lifecycle).toBe('TEMPORARY');
      expect(candidate.providerEligible).toBe(false);
      const { temporaryPath: _temporaryPath, ...metadata } = candidate;
      const technical = technicalSelection?.candidates.find((entry) => entry.candidateIndex === candidate.candidateIndex)?.technical;
      const representative = technicalSelection?.groups.some((group) => group.representativeIndex === candidate.candidateIndex);
      candidates.push({ ...metadata, ...(technical ? { technical } : {}),
        ...(transcript ? { transcriptSegments: transcriptAtTimestamp(transcript, candidate.timestampMs) } : {}) });
      gallery.push(`<figure><img loading="lazy" src="data:image/jpeg;base64,${bytes.toString('base64')}" alt="Frame ${candidate.candidateIndex}"><figcaption>#${candidate.candidateIndex} · ${(candidate.timestampMs / 1000).toFixed(3)}s · ${candidate.extractionReasons.join(' + ')}${technical ? `<br>Technical score ${technical.qualityScore.toFixed(3)}${representative ? ' · REPRESENTATIVE' : ''}` : ''}</figcaption></figure>`);
    }
    return {
      inputFileName: fileName, sourceHash, sourceBytes: buffer.length, startedAt,
      runtime, runtimeSha256, policy: set.policy, durationMs: set.durationMs,
      effectiveIntervalFps: set.effectiveIntervalFps, candidateCount: candidates.length,
      intervalCount: interval.length, sceneCount: scenes.length,
      maxIntervalGapMs: Math.max(0, ...gapsMs),
      expectedSceneWindowsMs: sceneWindows,
      sceneCoverage: sceneWindows.length ? 'EXPECTED_WINDOWS_PASSED' : 'REQUIRES_VISUAL_REVIEW',
      candidates, technicalSelection, transcript,
    };
  });
  for (const ownedPath of ownedPaths) await expect(access(ownedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  const result = { ...report, processingRuntimeMs: Math.round(performance.now() - started), cleanup: 'PASSED' };
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TRA frame extraction validation</title>
<style>body{font:16px system-ui;margin:24px;background:#f3f4f6;color:#172033}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}figure{margin:0;background:white;padding:8px;border-radius:8px}img{width:100%;height:260px;object-fit:contain}figcaption{font-size:13px}pre{white-space:pre-wrap}</style>
<h1>TRA frame extraction validation</h1><p>${escapeHtml(fileName)}</p>
<p>Local inspection only. These samples are temporary candidates, provider-ineligible, and are not approved generation references. Working files were cleaned; this gallery retains inspection copies.</p>
<p>${result.candidateCount} candidates · ${result.intervalCount} interval · ${result.sceneCount} scene · ${result.processingRuntimeMs}ms processing · cleanup passed</p>
<p>Scene coverage: ${result.sceneCoverage}. Inspect beginning, middle, end and brief graphics against the source video.</p>
${result.technicalSelection ? `<h2>Technical duplicate groups</h2><p>${result.technicalSelection.groups.length} representatives from ${result.candidateCount} candidates. All alternatives are retained; technical scores do not establish identity or approval.</p><pre>${escapeHtml(JSON.stringify(result.technicalSelection.groups, null, 2))}</pre>` : ''}
${result.transcript ? `<h2>Timestamped transcript</h2><p>Speech aligned by time; it does not identify visible people.</p><pre>${escapeHtml(JSON.stringify(result.transcript.segments, null, 2))}</pre>` : ''}
<main>${gallery.join('\n')}</main></html>`);
  console.log(`Video validation report: ${path.join(output, 'report.json')}`);
  console.log(`Video validation gallery: ${path.join(output, 'index.html')}`);
}, 240_000);
