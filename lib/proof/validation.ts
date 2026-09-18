import type {
  CaseStudyProofDraft,
  ReviewAttribution,
  ReviewProofDraft,
} from '@/lib/proof/types';

const SAFE_PROOF_ID = /^proof_[a-f0-9]{32}$/;
const MAX_REVIEW_LENGTH = 20_000;
const MAX_TEXT_LENGTH = 4_000;
const MAX_TAGS = 30;
const MAX_TAG_LENGTH = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const optionalText = (value: unknown) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= MAX_TEXT_LENGTH ? text : null;
};

const exactText = (value: unknown) =>
  typeof value === 'string' && value.trim() && value.length <= MAX_TEXT_LENGTH
    ? value
    : null;

const parseTags = (value: unknown): string[] | null | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TAGS) return null;
  const tags = value.map((tag) =>
    typeof tag === 'string' ? tag.trim() : ''
  );
  if (
    tags.some((tag) => !tag || tag.length > MAX_TAG_LENGTH) ||
    new Set(tags).size !== tags.length
  ) {
    return null;
  }
  return tags;
};

const parseAttribution = (
  value: unknown
): ReviewAttribution | null | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length !== 2) return null;
  const display = optionalText(value.display);
  return display && value.allowed === true ? { display, allowed: true } : null;
};

export const isProofId = (value: unknown): value is string =>
  typeof value === 'string' && SAFE_PROOF_ID.test(value);

export function parseReviewProofDraft(value: unknown): ReviewProofDraft | null {
  if (!isRecord(value)) return null;
  const originalReviewText = value.originalReviewText;
  if (
    typeof originalReviewText !== 'string' ||
    !originalReviewText.trim() ||
    originalReviewText.length > MAX_REVIEW_LENGTH
  ) {
    return null;
  }

  const source = optionalText(value.source);
  if (source === null) return null;
  const attribution = parseAttribution(value.attribution);
  if (attribution === null) return null;
  const rating = value.rating;
  if (
    rating !== undefined &&
    (typeof rating !== 'number' ||
      !Number.isFinite(rating) ||
      rating < 1 ||
      rating > 5)
  ) {
    return null;
  }
  const tags = parseTags(value.tags);
  if (tags === null) return null;

  return {
    originalReviewText,
    ...(source ? { source } : {}),
    ...(attribution ? { attribution } : {}),
    ...(rating !== undefined ? { rating } : {}),
    ...(tags ? { tags } : {}),
  };
}

export function parseCaseStudyProofDraft(
  value: unknown
): CaseStudyProofDraft | null {
  if (!isRecord(value)) return null;
  const title = exactText(value.title);
  const approvedClaimWording = exactText(value.approvedClaimWording);
  const sourceNote = exactText(value.sourceNote);
  if (!title || !approvedClaimWording || !sourceNote) return null;

  if (!Array.isArray(value.verifiedFacts) || !value.verifiedFacts.length) {
    return null;
  }
  const verifiedFacts = value.verifiedFacts.map(exactText);
  if (verifiedFacts.some((fact) => !fact)) return null;

  const usageRestrictions =
    value.usageRestrictions === undefined
      ? undefined
      : exactText(value.usageRestrictions);
  const requiredDisclaimer =
    value.requiredDisclaimer === undefined
      ? undefined
      : exactText(value.requiredDisclaimer);
  const tags = parseTags(value.tags);
  if (
    usageRestrictions === null ||
    requiredDisclaimer === null ||
    tags === null
  ) {
    return null;
  }

  return {
    title,
    verifiedFacts: verifiedFacts as string[],
    approvedClaimWording,
    sourceNote,
    ...(usageRestrictions ? { usageRestrictions } : {}),
    ...(requiredDisclaimer ? { requiredDisclaimer } : {}),
    ...(tags ? { tags } : {}),
  };
}

const SENTENCE_TERMINATORS = new Set(['.', '!', '?']);
const CLOSING_PUNCTUATION = new Set(['"', "'", '’', '”', ')', ']', '}']);
const horizontalWhitespace = (character: string | undefined) =>
  character === ' ' || character === '\t';
const lineBreak = (character: string | undefined) =>
  character === '\n' || character === '\r';

const sentenceEndsAt = (value: string, end: number) => {
  let cursor = end - 1;
  while (cursor >= 0 && horizontalWhitespace(value[cursor])) cursor -= 1;
  while (cursor >= 0 && CLOSING_PUNCTUATION.has(value[cursor])) cursor -= 1;
  return cursor >= 0 && SENTENCE_TERMINATORS.has(value[cursor]);
};

const sourceBoundStart = (source: string, start: number) => {
  if (start === 0) return true;
  let cursor = start - 1;
  if (lineBreak(source[cursor])) return true;
  let sawWhitespace = false;
  while (cursor >= 0 && horizontalWhitespace(source[cursor])) {
    sawWhitespace = true;
    cursor -= 1;
  }
  if (cursor < 0 || lineBreak(source[cursor])) return true;
  while (cursor >= 0 && CLOSING_PUNCTUATION.has(source[cursor])) cursor -= 1;
  return sawWhitespace && cursor >= 0 && SENTENCE_TERMINATORS.has(source[cursor]);
};

const sourceBoundEnd = (source: string, end: number, excerpt: string) => {
  if (end === source.length || lineBreak(source[end])) return true;
  let cursor = end;
  while (cursor < source.length && CLOSING_PUNCTUATION.has(source[cursor])) cursor += 1;
  let sawWhitespace = false;
  while (cursor < source.length && horizontalWhitespace(source[cursor])) {
    sawWhitespace = true;
    cursor += 1;
  }
  if (cursor === source.length || lineBreak(source[cursor])) return true;
  return sawWhitespace && sentenceEndsAt(excerpt, excerpt.length);
};

export const isVerbatimReviewExcerpt = (
  originalReviewText: string,
  excerpt: string
) => {
  if (!excerpt.length) return false;
  let start = originalReviewText.indexOf(excerpt);
  while (start !== -1) {
    const end = start + excerpt.length;
    if (
      sourceBoundStart(originalReviewText, start)
      && sourceBoundEnd(originalReviewText, end, excerpt)
    ) {
      return true;
    }
    start = originalReviewText.indexOf(excerpt, start + 1);
  }
  return false;
};

export const reviewSourceBoundUnits = (originalReviewText: string) => {
  const units = new Set<string>();
  for (const rawLine of originalReviewText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    units.add(line);

    let start = 0;
    for (let index = 0; index < line.length; index += 1) {
      if (!SENTENCE_TERMINATORS.has(line[index])) continue;
      let end = index + 1;
      while (end < line.length && SENTENCE_TERMINATORS.has(line[end])) end += 1;
      while (end < line.length && CLOSING_PUNCTUATION.has(line[end])) end += 1;
      if (end < line.length && !horizontalWhitespace(line[end])) continue;
      const sentence = line.slice(start, end).trim();
      if (sentence) units.add(sentence);
      while (end < line.length && horizontalWhitespace(line[end])) end += 1;
      start = end;
      index = end - 1;
    }
  }
  return [...units];
};

export function requireVerbatimReviewExcerpt(
  originalReviewText: string,
  excerpt: string
) {
  if (!isVerbatimReviewExcerpt(originalReviewText, excerpt)) {
    throw new Error(
      'Review excerpt must be exact source text bounded by whole sentence or whole line boundaries.'
    );
  }
  return excerpt;
}

export const isApprovedCaseStudyClaim = (
  approvedClaimWording: string,
  proposedClaim: string
) => proposedClaim === approvedClaimWording;
