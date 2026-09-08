import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrandFontMimeType } from '@/lib/company/brand-fonts';
const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  s3Send: vi.fn(),
}));
vi.mock('fs/promises', () => ({
  mkdir: mocks.mkdir,
  readFile: vi.fn(),
  unlink: vi.fn(),
  writeFile: mocks.writeFile,
}));
vi.mock('@aws-sdk/client-s3', () => ({
  DeleteObjectCommand: class {},
  GetObjectCommand: class {},
  NoSuchKey: class extends Error {},
  PutObjectCommand: class {},
  S3Client: class { send = mocks.s3Send; },
}));
import { saveBrandFont } from '@/lib/company/font-storage';
import {
  BrandFontValidationError,
  validateBrandFontBuffer,
} from '@/lib/company/font-validation.server';
const MIME = {
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff: 'font/woff',
  woff2: 'font/woff2',
} satisfies Record<string, BrandFontMimeType>;
type Extension = keyof typeof MIME;
const EXTENSIONS = Object.keys(MIME) as Extension[];
const fixture = (extension: Extension) => readFileSync(resolve(
  process.cwd(),
  `tests/fixtures/fonts/source-sans-3-regular.${extension}`
));
const clone = (buffer: Buffer) => Buffer.from(buffer);
const withHeader = (extension: 'woff' | 'woff2', offset: number, value: number, short = false) => {
  const buffer = clone(fixture(extension));
  short ? buffer.writeUInt16BE(value, offset) : buffer.writeUInt32BE(value, offset);
  return buffer;
};
const corruptedWoff = () => {
  const buffer = clone(fixture('woff'));
  for (let cursor = 44; cursor < 44 + buffer.readUInt16BE(12) * 20; cursor += 20) {
    const offset = buffer.readUInt32BE(cursor + 4);
    const compressed = buffer.readUInt32BE(cursor + 8);
    const original = buffer.readUInt32BE(cursor + 12);
    if (compressed < original) {
      buffer[offset + Math.floor(compressed / 2)] ^= 0xff;
      return buffer;
    }
  }
  throw new Error('Fixture has no compressed WOFF table.');
};
const woffWithGap = () => {
  const buffer = fixture('woff');
  const directoryEnd = 44 + buffer.readUInt16BE(12) * 20;
  const result = Buffer.concat([
    buffer.subarray(0, directoryEnd), Buffer.alloc(4), buffer.subarray(directoryEnd),
  ]);
  result.writeUInt32BE(result.byteLength, 8);
  for (let cursor = 44; cursor < directoryEnd; cursor += 20) {
    result.writeUInt32BE(result.readUInt32BE(cursor + 4) + 4, cursor + 4);
  }
  for (const offsetField of [24, 36]) {
    if (result.readUInt32BE(offsetField)) {
      result.writeUInt32BE(result.readUInt32BE(offsetField) + 4, offsetField);
    }
  }
  return result;
};
const woffWithNonzeroPadding = () => {
  const buffer = clone(fixture('woff'));
  const directoryEnd = 44 + buffer.readUInt16BE(12) * 20;
  for (let cursor = 44; cursor < directoryEnd; cursor += 20) {
    const offset = buffer.readUInt32BE(cursor + 4);
    const length = buffer.readUInt32BE(cursor + 8);
    if (length % 4) { buffer[offset + length] = 1; return buffer; }
  }
  throw new Error('Fixture has no padded WOFF table.');
};
const woffWithReorderedDirectory = () => {
  const buffer = clone(fixture('woff'));
  const first = Buffer.from(buffer.subarray(44, 64));
  buffer.copy(buffer, 44, 64, 84); first.copy(buffer, 64);
  return buffer;
};
const corruptedWoff2 = () => {
  const buffer = clone(fixture('woff2'));
  const compressed = buffer.readUInt32BE(20); const offset = buffer.byteLength - compressed;
  buffer[offset + Math.floor(compressed / 2)] ^= 0xff;
  return buffer;
};
const oversizedWoff2Directory = () => {
  const buffer = clone(fixture('woff2'));
  const start = (buffer[48] & 0x3f) === 63 ? 53 : 49;
  let end = start; while (buffer[end] & 0x80) end += 1;
  const result = Buffer.concat([
    buffer.subarray(0, start), Buffer.from([0xa0, 0x80, 0x80, 0x01]), buffer.subarray(end + 1),
  ]);
  result.writeUInt32BE(result.byteLength, 8); return result;
};
const woff2WithInterveningTable = () => {
  const buffer = fixture('woff2');
  return Buffer.concat([buffer.subarray(0, 74), buffer.subarray(78, 80), buffer.subarray(74, 78), buffer.subarray(80)]);
};
const invalidCases = (): Array<[string, Extension, Buffer]> => [
  ...EXTENSIONS.map((extension) => [
    `truncated ${extension}`,
    extension,
    fixture(extension).subarray(0, Math.floor(fixture(extension).byteLength / 2)),
  ] as [string, Extension, Buffer]),
  ['TTF bytes named OTF', 'otf', fixture('ttf')],
  ['OTF bytes named TTF', 'ttf', fixture('otf')],
  ['WOFF bytes named WOFF2', 'woff2', fixture('woff')],
  ['WOFF2 bytes named WOFF', 'woff', fixture('woff2')],
  ['WOFF collection flavor', 'woff', withHeader('woff', 4, 0x74746366)],
  ['WOFF unknown flavor', 'woff', withHeader('woff', 4, 0x12345678)],
  ['WOFF2 collection flavor', 'woff2', withHeader('woff2', 4, 0x74746366)],
  ['WOFF2 unknown flavor', 'woff2', withHeader('woff2', 4, 0x12345678)],
  ['WOFF2 reserved field', 'woff2', withHeader('woff2', 14, 1, true)],
  ['oversized WOFF2 header expansion', 'woff2', withHeader('woff2', 16, 0xffffffff)],
  ['oversized WOFF2 directory expansion', 'woff2', oversizedWoff2Directory()],
  ['WOFF out-of-order directory', 'woff', woffWithReorderedDirectory()],
  ['WOFF gap between directory and tables', 'woff', woffWithGap()],
  ['WOFF nonzero table padding', 'woff', woffWithNonzeroPadding()],
  ['corrupt WOFF compressed payload', 'woff', corruptedWoff()],
  ['corrupt WOFF2 Brotli payload', 'woff2', corruptedWoff2()],
  ['WOFF2 decompressed length mismatch', 'woff2', (() => {
    const buffer = clone(fixture('woff2'));
    let cursor = (buffer[48] & 0x3f) === 63 ? 53 : 49;
    while (buffer[cursor] & 0x80) cursor += 1;
    buffer[cursor] ^= 1;
    return buffer;
  })()],
  ['malformed WOFF2 UIntBase128', 'woff2', (() => {
    const buffer = clone(fixture('woff2'));
    buffer[(buffer[48] & 0x3f) === 63 ? 53 : 49] = 0x80;
    return buffer;
  })()],
  ['out-of-range TTF table', 'ttf', (() => {
    const buffer = clone(fixture('ttf'));
    buffer.writeUInt32BE(buffer.byteLength + 4, 20);
    return buffer;
  })()],
  ['out-of-file zero-length TTF table', 'ttf', (() => {
    const buffer = clone(fixture('ttf'));
    buffer.writeUInt32BE(buffer.byteLength + 1, 20); buffer.writeUInt32BE(0, 24);
    return buffer;
  })()],
  ['oversized declared WOFF expansion', 'woff', (() => {
    const buffer = clone(fixture('woff'));
    buffer.writeUInt32BE(0xffffffff, 56);
    return buffer;
  })()],
];
describe('brand font content validation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
  });
  it.each(EXTENSIONS)('accepts and locally stores a real %s font', async (extension) => {
    const buffer = fixture(extension);
    expect(() => validateBrandFontBuffer(buffer, MIME[extension])).not.toThrow();
    const asset = await saveBrandFont(new File([new Uint8Array(buffer)], `Source Sans 3.${extension}`));
    expect(asset).toMatchObject({ mimeType: MIME[extension], size: buffer.byteLength });
    expect(mocks.writeFile).toHaveBeenCalledOnce();
  });
  it('accepts bounded WOFF2 reference-size differences and intervening tables', () => {
    expect(() => validateBrandFontBuffer(withHeader('woff2', 16, fixture('woff2').readUInt32BE(16) + 4), MIME.woff2)).not.toThrow();
    expect(() => validateBrandFontBuffer(woff2WithInterveningTable(), MIME.woff2)).not.toThrow();
  });
  it.each(invalidCases())('rejects %s', (_name, extension, buffer) => {
    expect(() => validateBrandFontBuffer(buffer, MIME[extension]))
      .toThrow(BrandFontValidationError);
  });
  it.each(['test', 'production'])('rejects all invalid files before %s storage', async (nodeEnv) => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    for (const [, extension, buffer] of invalidCases()) {
      await expect(saveBrandFont(new File([new Uint8Array(buffer)], `bad.${extension}`)))
        .rejects.toBeInstanceOf(BrandFontValidationError);
    }
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.s3Send).not.toHaveBeenCalled();
  });
});
