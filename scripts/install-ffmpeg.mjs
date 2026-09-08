import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const RELEASE = 'ffmpeg-7.0.2-tra.4';
const FFMPEG_VERSION = '7.0.2';
const FFMPEG_TAG = 'n7.0.2';
const SOURCE_URL = 'https://ffmpeg.org/releases/ffmpeg-7.0.2.tar.xz';
const SOURCE_SHA256 = '8646515b638a3ad303e23af6a3587734447cb8fc0a0c064ecdb8e95c4fd8b389';
const BASE_URL = `https://ffmpeg.arundelkramer.com/${RELEASE}`;
const RUNTIME_DIR = path.join(process.cwd(), '.runtime', 'ffmpeg');

const TARGETS = {
  'linux-x64': {
    asset: 'ffmpeg-linux-x64.gz',
    compressedSha256: '6df4462722ea35537300ba478ff16962576ee41a82140a023ea365e4d6922a8c',
    binarySha256: '93fa28078e3ce1aa04912c2cc7103a46bb406b3e143fb0942245e29875b3bb1b',
    licenseAsset: 'linux-x64.LICENSE',
    licenseSha256: 'b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe',
    provenanceAsset: 'linux-x64.provenance.json',
    provenanceSha256: '52ce6427360a8d5c54c7dde9fe6ed89385d9dfb5df6dca78fde711e67393b0d1',
    executable: 'ffmpeg',
  },
  'linux-arm64': {
    asset: 'ffmpeg-linux-arm64.gz',
    compressedSha256: 'c225c71dcf72d53a50e0bc1d11a11962b9f0b6bb33aeea0a89efb6318396af7b',
    binarySha256: '6f8061dfb9719478f616ffbbe11c46010e62c0f6f0659b34e47369a89236f414',
    licenseAsset: 'linux-arm64.LICENSE',
    licenseSha256: 'b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe',
    provenanceAsset: 'linux-arm64.provenance.json',
    provenanceSha256: '8030a8d45df1db0e6b8f845a119be46ec490a912be71d22ca6f9f6d32e307131',
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
    compressedSha256: '26a8940f2d40cb626cf32186237354f7a930900ae215fd401922b108babfea28',
    binarySha256: '2dc6695af06538cc3ffa1b4233167ddb2dd91a999aaf770a1cb37eee9317567d',
    licenseAsset: 'win32-x64.LICENSE',
    licenseSha256: 'b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe',
    provenanceAsset: 'win32-x64.provenance.json',
    provenanceSha256: 'f5dc18eda3d15453b3816b3030b24808ccf670cd7974b1da460f1376f16559ae',
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

const validateProvenance = (provenanceBuffer) => {
  if (sha256(provenanceBuffer) !== target.provenanceSha256) {
    throw new Error('Pinned FFmpeg provenance metadata failed SHA-256 verification.');
  }
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
};

const fileMatchesHash = async (filePath, expectedSha256) => {
  try {
    return sha256(await readFile(filePath)) === expectedSha256;
  } catch {
    return false;
  }
};

await mkdir(RUNTIME_DIR, { recursive: true });
const executablePath = path.join(RUNTIME_DIR, target.executable);
const licensePath = path.join(RUNTIME_DIR, 'FFMPEG-LICENSE.txt');
const provenancePath = path.join(RUNTIME_DIR, 'FFMPEG-PROVENANCE.json');

const installed = await fileMatchesHash(executablePath, target.binarySha256);
const licenseInstalled = await fileMatchesHash(licensePath, target.licenseSha256);
let provenanceInstalled = false;
try {
  validateProvenance(await readFile(provenancePath));
  provenanceInstalled = true;
} catch {
  provenanceInstalled = false;
}

let provenanceBuffer = null;
if (!provenanceInstalled) {
  provenanceBuffer = await fetchPinnedAsset(target.provenanceAsset, target.provenanceSha256);
  validateProvenance(provenanceBuffer);
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

if (!licenseInstalled) {
  await writeFile(licensePath, await fetchPinnedAsset(target.licenseAsset, target.licenseSha256));
}
if (!provenanceInstalled) {
  await writeFile(provenancePath, provenanceBuffer);
}

console.log(`Pinned FFmpeg ${FFMPEG_VERSION} (${RELEASE}) ready for ${targetKey}.`);
