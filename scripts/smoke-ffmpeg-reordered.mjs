import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const binaryPath = process.argv[2];
if (!binaryPath || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/smoke-ffmpeg-reordered.mjs <ffmpeg-binary>');
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureSource = readFileSync(path.join(scriptDir, '..', 'tests', 'fixtures', 'reordered-video.ts'), 'utf8');
const fixtureMatches = [...fixtureSource.matchAll(
  /export const REAL_REORDERED_MP4 = Buffer\.from\(\s*'([A-Za-z0-9+/=]+)'\s*,\s*'base64'\s*\);/g
)];
if (fixtureMatches.length !== 1) {
  throw new Error('The reordered-video fixture representation changed; update this smoke check deliberately.');
}

const workDir = mkdtempSync(path.join(tmpdir(), 'tra-ffmpeg-smoke-'));
const fixturePath = path.join(workDir, 'reordered.mp4');
try {
  writeFileSync(fixturePath, Buffer.from(fixtureMatches[0][1], 'base64'));
  const stdout = execFileSync(binaryPath, [
    '-hide_banner', '-nostdin', '-v', 'error', '-i', fixturePath,
    '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'null', '-',
    '-progress', 'pipe:1', '-nostats',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = stdout.trim().split(/\r?\n/);
  const progressEnd = lines.lastIndexOf('progress=end');
  const outTimeUs = lines.lastIndexOf('out_time_us=1034367');
  if (progressEnd !== lines.length - 1 || outTimeUs < 0 || outTimeUs > progressEnd) {
    throw new Error('FFmpeg reordered-video smoke check did not report final out_time_us=1034367 and progress=end.');
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
