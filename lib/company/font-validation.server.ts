import { brotliDecompressSync, inflateSync } from 'node:zlib';
import type { BrandFontMimeType } from '@/lib/company/brand-fonts';
const MAX_EXPANDED_FONT_BYTES = 64 * 1024 * 1024;
const SFNT_TRUETYPE = 0x00010000;
const SFNT_TRUE = 0x74727565;
const SFNT_OTTO = 0x4f54544f;
const WOFF = 0x774f4646;
const WOFF2 = 0x774f4632;
const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
] as const;
export class BrandFontValidationError extends Error {}
const invalid = (): never => {
  throw new BrandFontValidationError(
    'The uploaded file is malformed or does not match its font extension.'
  );
};
const inBounds = (buffer: Buffer, offset: number, length: number) =>
  Number.isSafeInteger(offset) &&
  Number.isSafeInteger(length) &&
  offset >= 0 &&
  length >= 0 &&
  offset + length <= buffer.byteLength;
const padded = (length: number) => Math.ceil(length / 4) * 4;
const isSupportedSfntFlavor = (flavor: number) => flavor === SFNT_TRUETYPE || flavor === SFNT_TRUE || flavor === SFNT_OTTO;
const validateZeroPadding = (buffer: Buffer, start: number, end: number) => {
  if (end - start > 3 || buffer.subarray(start, end).some((byte) => byte !== 0)) invalid();
};
const validateRanges = (
  ranges: Array<{ offset: number; length: number }>,
  minimumOffset: number,
  buffer: Buffer
) => {
  if (ranges.some(({ offset, length }) => !inBounds(buffer, offset, length))) invalid();
  const occupied = ranges.filter(({ length }) => length > 0).sort((left, right) => left.offset - right.offset);
  let end = minimumOffset;
  for (const range of occupied) {
    if (range.offset < end) invalid();
    end = range.offset + range.length;
  }
};
const validateOptionalBlocks = (
  buffer: Buffer,
  metaOffset: number,
  metaLength: number,
  metaOrigLength: number,
  privOffset: number,
  privLength: number
) => {
  // Optional metadata is range-bounded but not decoded because invalid metadata must not affect font loading.
  if (
    (metaOffset === 0) !== (metaLength === 0) ||
    (metaOffset === 0 && metaOrigLength !== 0) ||
    (privOffset === 0) !== (privLength === 0)
  ) invalid();
  return [{ offset: metaOffset, length: metaLength }, { offset: privOffset, length: privLength }];
};
const validateSfnt = (buffer: Buffer, mimeType: BrandFontMimeType) => {
  if (buffer.byteLength < 12) invalid();
  const flavor = buffer.readUInt32BE(0);
  const validFlavor = mimeType === 'font/ttf'
    ? flavor === SFNT_TRUETYPE || flavor === SFNT_TRUE
    : flavor === SFNT_OTTO;
  if (!validFlavor) invalid();
  const numTables = buffer.readUInt16BE(4);
  const directoryEnd = 12 + numTables * 16;
  if (!numTables || directoryEnd > buffer.byteLength) invalid();
  const power = 2 ** Math.floor(Math.log2(numTables));
  if (
    buffer.readUInt16BE(6) !== power * 16 ||
    buffer.readUInt16BE(8) !== Math.log2(power) ||
    buffer.readUInt16BE(10) !== numTables * 16 - power * 16
  ) invalid();
  const tags = new Set<number>();
  const ranges: Array<{ offset: number; length: number }> = [];
  let previousTag = -1;
  for (let cursor = 12; cursor < directoryEnd; cursor += 16) {
    const tag = buffer.readUInt32BE(cursor);
    const offset = buffer.readUInt32BE(cursor + 8);
    const length = buffer.readUInt32BE(cursor + 12);
    if (tags.has(tag) || tag <= previousTag || offset % 4 !== 0) invalid();
    tags.add(tag);
    previousTag = tag;
    ranges.push({ offset, length });
  }
  validateRanges(ranges, directoryEnd, buffer);
};
const validateWoff = (buffer: Buffer) => {
  if (buffer.byteLength < 44 || buffer.readUInt32BE(0) !== WOFF) invalid();
  if (
    !isSupportedSfntFlavor(buffer.readUInt32BE(4)) ||
    buffer.readUInt32BE(8) !== buffer.byteLength ||
    buffer.readUInt16BE(14) !== 0
  ) invalid();
  const numTables = buffer.readUInt16BE(12);
  const directoryEnd = 44 + numTables * 20;
  if (!numTables || directoryEnd > buffer.byteLength) invalid();
  const tags = new Set<number>();
  const tables: Array<{ offset: number; length: number }> = [];
  let expandedSize = 12 + numTables * 16;
  let previousTag = -1;
  for (let cursor = 44; cursor < directoryEnd; cursor += 20) {
    const tag = buffer.readUInt32BE(cursor);
    const offset = buffer.readUInt32BE(cursor + 4);
    const compressedLength = buffer.readUInt32BE(cursor + 8);
    const originalLength = buffer.readUInt32BE(cursor + 12);
    if (
      tags.has(tag) || tag <= previousTag || offset % 4 !== 0 ||
      compressedLength > originalLength
    ) invalid();
    tags.add(tag);
    previousTag = tag;
    expandedSize += padded(originalLength);
    if (expandedSize > MAX_EXPANDED_FONT_BYTES) invalid();
    tables.push({ offset, length: compressedLength });
    if (compressedLength < originalLength) {
      try {
        const output = inflateSync(buffer.subarray(offset, offset + compressedLength), {
          maxOutputLength: originalLength,
        });
        if (output.byteLength !== originalLength) invalid();
      } catch {
        invalid();
      }
    }
  }
  if (buffer.readUInt32BE(16) !== expandedSize) invalid();
  const metaOffset = buffer.readUInt32BE(24);
  const metaLength = buffer.readUInt32BE(28);
  const privOffset = buffer.readUInt32BE(36);
  const privLength = buffer.readUInt32BE(40);
  const optionalBlocks = validateOptionalBlocks(
    buffer,
    metaOffset, metaLength, buffer.readUInt32BE(32), privOffset, privLength
  );
  validateRanges([...tables, ...optionalBlocks], directoryEnd, buffer);

  let physicalEnd = directoryEnd;
  for (const table of tables.filter(({ length }) => length > 0).sort((a, b) => a.offset - b.offset)) {
    if (table.offset !== physicalEnd) invalid();
    const dataEnd = table.offset + table.length;
    physicalEnd = table.offset + padded(table.length);
    if (physicalEnd > buffer.byteLength) invalid();
    validateZeroPadding(buffer, dataEnd, physicalEnd);
  }
  if (metaLength) {
    if (metaOffset !== physicalEnd) invalid();
    physicalEnd = metaOffset + metaLength;
    if (privLength) {
      const paddedMetaEnd = padded(physicalEnd);
      validateZeroPadding(buffer, physicalEnd, paddedMetaEnd);
      physicalEnd = paddedMetaEnd;
    }
  }
  if (privLength) {
    if (privOffset !== physicalEnd) invalid();
    physicalEnd = privOffset + privLength;
  }
  if (physicalEnd !== buffer.byteLength) invalid();
};
interface Cursor { value: number }
const readBase128 = (buffer: Buffer, cursor: Cursor) => {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    if (cursor.value >= buffer.byteLength) invalid();
    const byte = buffer[cursor.value++];
    if (index === 0 && byte === 0x80) invalid();
    if ((value & 0xfe000000) !== 0) invalid();
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
  }
  return invalid();
};
const validateWoff2 = (buffer: Buffer) => {
  if (buffer.byteLength < 48 || buffer.readUInt32BE(0) !== WOFF2) invalid();
  if (
    !isSupportedSfntFlavor(buffer.readUInt32BE(4)) ||
    buffer.readUInt32BE(8) !== buffer.byteLength ||
    buffer.readUInt16BE(14) !== 0
  ) invalid();
  const numTables = buffer.readUInt16BE(12);
  const totalSfntSize = buffer.readUInt32BE(16);
  // WOFF2 totalSfntSize is reference-only; bound it but do not require reconstructed-size equality.
  if (
    !numTables ||
    totalSfntSize < 12 + numTables * 16 ||
    totalSfntSize > MAX_EXPANDED_FONT_BYTES
  ) invalid();
  const cursor: Cursor = { value: 48 };
  const tags = new Set<string>();
  const entries: Array<{ tag: string; transformed: boolean; length: number }> = [];
  let expandedSize = 0;
  let declaredSfntSize = 12 + numTables * 16;
  for (let index = 0; index < numTables; index += 1) {
    if (cursor.value >= buffer.byteLength) invalid();
    const flags = buffer[cursor.value++];
    const tagIndex = flags & 0x3f;
    let tag: string;
    if (tagIndex === 63) {
      if (!inBounds(buffer, cursor.value, 4)) invalid();
      tag = buffer.toString('latin1', cursor.value, cursor.value + 4);
      cursor.value += 4;
    } else {
      tag = WOFF2_TAGS[tagIndex];
    }
    if (tags.has(tag)) invalid();
    tags.add(tag);
    const transformVersion = flags >>> 6;
    const transformed = tag === 'glyf' || tag === 'loca'
      ? transformVersion === 0
      : tag === 'hmtx' && transformVersion === 1;
    const validTransform = tag === 'glyf' || tag === 'loca'
      ? transformVersion === 0 || transformVersion === 3
      : tag === 'hmtx'
        ? transformVersion === 0 || transformVersion === 1
        : transformVersion === 0;
    if (!validTransform) invalid();
    const originalLength = readBase128(buffer, cursor);
    const storedLength = transformed ? readBase128(buffer, cursor) : originalLength;
    if (tag === 'loca' && transformed && storedLength !== 0) invalid();
    declaredSfntSize += padded(originalLength);
    expandedSize += storedLength;
    if (
      declaredSfntSize > MAX_EXPANDED_FONT_BYTES ||
      expandedSize > MAX_EXPANDED_FONT_BYTES
    ) invalid();
    entries.push({ tag, transformed, length: storedLength });
  }
  const glyfIndex = entries.findIndex(({ tag, transformed }) => tag === 'glyf' && transformed);
  const locaIndex = entries.findIndex(({ tag, transformed }) => tag === 'loca' && transformed);
  if ((glyfIndex < 0) !== (locaIndex < 0) || (glyfIndex >= 0 && locaIndex <= glyfIndex)) invalid();
  const compressedLength = buffer.readUInt32BE(20);
  const compressedOffset = cursor.value;
  const ranges = [
    { offset: compressedOffset, length: compressedLength },
    ...validateOptionalBlocks(
      buffer,
      buffer.readUInt32BE(28), buffer.readUInt32BE(32), buffer.readUInt32BE(36),
      buffer.readUInt32BE(40), buffer.readUInt32BE(44)
    ),
  ];
  validateRanges(ranges, compressedOffset, buffer);
  try {
    const output = brotliDecompressSync(
      buffer.subarray(compressedOffset, compressedOffset + compressedLength),
      { maxOutputLength: MAX_EXPANDED_FONT_BYTES }
    );
    if (output.byteLength !== expandedSize) invalid();
  } catch {
    invalid();
  }
};
export const validateBrandFontBuffer = (buffer: Buffer, mimeType: BrandFontMimeType) => {
  if (mimeType === 'font/ttf' || mimeType === 'font/otf') return validateSfnt(buffer, mimeType);
  if (mimeType === 'font/woff') return validateWoff(buffer);
  return validateWoff2(buffer);
};
