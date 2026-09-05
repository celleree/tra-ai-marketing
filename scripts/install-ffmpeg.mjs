import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const RELEASE = 'ffmpeg-7.0.2-tra.3';
const FFMPEG_VERSION = '7.0.2';
const FFMPEG_TAG = 'n7.0.2';
const SOURCE_URL = 'https://ffmpeg.org/releases/ffmpeg-7.0.2.tar.xz';
const SOURCE_SHA256 = '8646515b638a3ad303e23af6a3587734447cb8fc0a0c064ecdb8e95c4fd8b389';
const BASE_URL = `https://ffmpeg.arundelkramer.com/${RELEASE}`;
const RUNTIME_DIR = path.join(process.cwd(), '.runtime', 'ffmpeg');

const TARGETS = {
  'linux-x64': {
    asset: 'ffmpeg-linux-x64.gz',
    compressedSha256: '7b9d54bb1228f405a9994d2cde29ab59a4691bf307a0a7c008868c1f93a9c804',
    binarySha256: 'de70fae6e2fa43c1dc318b16ea064fdd67c91418bfcf6557ae674cb64f495bea',
    licenseAsset: 'linux-x64.LICENSE',
    licenseSha256: 'b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe',
    provenanceAsset: 'linux-x64.provenance.json',
    provenanceSha256: '57de96866c5bf17ad7123444edb2b8c5d1914bf4ec648293e8986e0325148242',
    executable: 'ffmpeg',
  },
  'linux-arm64': {
    asset: 'ffmpeg-linux-arm64.gz',
    compressedSha256: 'eea83e80ed738237c2a305d8fca55d0fe70544245da324bd6bd2849c17dbcd7d',
    binarySha256: 'bd6557b323edf8dd51198b18f631b5f3fe3d30515ebbf33e6fb5360ab4644cff',
    licenseAsset: 'linux-arm64.LICENSE',
    licenseSha256: 'b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe',
    provenanceAsset: 'linux-arm64.provenance.json',
    provenanceSha256: '569126380e640c84123f5b12f90b22ca4e4a95d978ab989e951847e93c37b92a',
    executable: 'ffmpeg',
  },
  'darwin-x64': {
    asset: 'ffmpeg-darwin-x64.gz',
    compressedSha256: '9fbec0e72d4b1a919b504a30ff17e9e6901f35d55b1fe793c6d9dc4a356f7311',
    binarySha256: '0a3334d9dba16563b15f3f3dcf55114f2ae2347fa4ea74cbdf3d71ed6660f5eb',
    licenseAsset: 'darwin-x64.LICENSE',
    licenseSha256: 'b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe',
    provenanceAsset: 'darwin-x64.provenance.json',
    provenanceSha256: 'b9e3d274d983c40015e102f3b3cc036b2e7034392889d69d9c9d83f99c556524',
    executable: 'ffmpeg',
  },
  'darwin-arm64': {
    asset: 'ffmpeg-darwin-arm64.gz',
    compressedSha256: '023236ad1f8b9ccdcfbf64d82e462ce765e5d5aed8fb3052632ab40a0fc351bd',
    binarySha256: 'ada4852659fd5bc2b81aaef6a831a4180c8686af7310fd78902e471a13e7dee4',
    licenseAsset: 'darwin-arm64.LICENSE',
    licenseSha256: 'b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe',
    provenanceAsset: 'darwin-arm64.provenance.json',
    provenanceSha256: 'd0fc92c195bc25515d3faa99b018f87ac3b3144c33c8761fe22a93887818bd83',
    executable: 'ffmpeg',
  },
  'win32-x64': {
    asset: 'ffmpeg-win32-x64.gz',
    compressedSha256: 'e742fe4af925e483782b36e7487aeeebf8b4acb1dcd83831076864f2ceda269f',
    binarySha256: '40a08e1db61bc49c045d6d98ea34d8e25bebdf010b1a813290c12e9d734093d0',
    licenseAsset: 'win32-x64.LICENSE',
    licenseSha256: 'b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe',
    provenanceAsset: 'win32-x64.provenance.json',
    provenanceSha256: 'cd7dd473980286a442ffcae9b8d67a2b96826f1d04c1ef869525deb91e71f264',
    executable: 'ffmpeg.exe',
  },
};

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const fetchPinnedAsset = async (asset, expectedSha256) => {
  const response = await fetch(`${BASE_URL}/${asset}`, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Failed to download pinned FFmpeg asset ${asset}: HTTP ${response.status}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (sha256(buffer) !== expectedSha256) throw new Error(`Pinned FFmpeg asset ${asset} failed SHA-256 verification.`);
  return buffer;
};

const targetKey = `${process.platform}-${process.arch}`;
const target = TARGETS[targetKey];
if (!target) throw new Error(`Unsupported platform for TRA video preprocessing: ${targetKey}.`);

const provenanceBuffer = await fetchPinnedAsset(target.provenanceAsset, target.provenanceSha256);
let provenance;
try {
  provenance = JSON.parse(provenanceBuffer.toString('utf8'));
} catch {
  throw new Error('Pinned FFmpeg provenance metadata is not valid JSON.');
}
if (
  provenance?.ffmpegVersion !== FFMPEG_VERSION ||
  provenance?.ffmpegTag !== FFMPEG_TAG ||
  provenance?.sourceUrl !== SOURCE_URL ||
  provenance?.sourceSha256 !== SOURCE_SHA256 ||
  provenance?.target !== targetKey ||
  provenance?.compressedSha256 !== target.compressedSha256 ||
  provenance?.binarySha256 !== target.binarySha256
) {
  throw new Error(`Pinned FFmpeg provenance metadata failed validation for ${targetKey}.`);
}

await mkdir(RUNTIME_DIR, { recursive: true });
const executablePath = path.join(RUNTIME_DIR, target.executable);
const licensePath = path.join(RUNTIME_DIR, 'FFMPEG-LICENSE.txt');

let installed = false;
try {
  installed = sha256(await readFile(executablePath)) === target.binarySha256;
} catch {
  installed = false;
}
if (!installed) {
  const compressed = await fetchPinnedAsset(target.asset, target.compressedSha256);
  const binary = gunzipSync(compressed);
  if (sha256(binary) !== target.binarySha256) {
    throw new Error('Pinned FFmpeg binary failed SHA-256 verification after decompression.');
  }
  await writeFile(executablePath, binary);
}
if (process.platform !== 'win32') await chmod(executablePath, 0o755);

let licenseInstalled = false;
try {
  licenseInstalled = sha256(await readFile(licensePath)) === target.licenseSha256;
} catch {
  licenseInstalled = false;
}
if (!licenseInstalled) {
  await writeFile(licensePath, await fetchPinnedAsset(target.licenseAsset, target.licenseSha256));
}

console.log(`Pinned FFmpeg ${FFMPEG_VERSION} (${RELEASE}) ready for ${targetKey}.`);
