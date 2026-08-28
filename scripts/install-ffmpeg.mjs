import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const RELEASE = 'b6.1.1';
const BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}`;
const RUNTIME_DIR = path.join(process.cwd(), '.runtime', 'ffmpeg');

const TARGETS = {
  'linux-x64': { asset: 'ffmpeg-linux-x64.gz', compressedSha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa', binarySha256: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99', licenseAsset: 'linux-x64.LICENSE', licenseSha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903', executable: 'ffmpeg' },
  'linux-arm64': { asset: 'ffmpeg-linux-arm64.gz', compressedSha256: '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0', binarySha256: '6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce', licenseAsset: 'linux-arm64.LICENSE', licenseSha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903', executable: 'ffmpeg' },
  'darwin-x64': { asset: 'ffmpeg-darwin-x64.gz', compressedSha256: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106', binarySha256: 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894', licenseAsset: 'darwin-x64.LICENSE', licenseSha256: '2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af', executable: 'ffmpeg' },
  'darwin-arm64': { asset: 'ffmpeg-darwin-arm64.gz', compressedSha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa', binarySha256: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584', licenseAsset: 'darwin-arm64.LICENSE', licenseSha256: 'cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2', executable: 'ffmpeg' },
  'win32-x64': { asset: 'ffmpeg-win32-x64.gz', compressedSha256: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77', binarySha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00', licenseAsset: 'win32-x64.LICENSE', licenseSha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903', executable: 'ffmpeg.exe' },
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
await mkdir(RUNTIME_DIR, { recursive: true });
const executablePath = path.join(RUNTIME_DIR, target.executable);
const licensePath = path.join(RUNTIME_DIR, 'FFMPEG-LICENSE.txt');

let installed = false;
try { installed = sha256(await readFile(executablePath)) === target.binarySha256; } catch { installed = false; }
if (!installed) {
  const binary = gunzipSync(await fetchPinnedAsset(target.asset, target.compressedSha256));
  if (sha256(binary) !== target.binarySha256) throw new Error('Pinned FFmpeg binary failed SHA-256 verification after decompression.');
  await writeFile(executablePath, binary);
}
if (process.platform !== 'win32') await chmod(executablePath, 0o755);
let licenseInstalled = false;
try { licenseInstalled = sha256(await readFile(licensePath)) === target.licenseSha256; } catch { licenseInstalled = false; }
if (!licenseInstalled) await writeFile(licensePath, await fetchPinnedAsset(target.licenseAsset, target.licenseSha256));
console.log(`Pinned FFmpeg ${RELEASE} ready for ${targetKey}.`);
