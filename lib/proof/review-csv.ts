import type { ReviewProofDraft } from '@/lib/proof/types';
import { parseReviewProofDraft } from '@/lib/proof/validation';

export const MAX_REVIEW_CSV_BYTES = 2 * 1024 * 1024;

type ParsedRecord = { cells: string[]; rowNumber: number };
type ReviewCsvRow = { type: 'review' } & ReviewProofDraft;

const HEADERS = new Set([
  'originalReviewText',
  'source',
  'displayAttribution',
  'attributionAllowed',
  'rating',
  'tags',
]);

function parseCsvRecords(input: string): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let closedQuote = false;
  let rowNumber = 1;
  let recordStart = 1;

  const finishRecord = () => {
    records.push({ cells: [...cells, cell], rowNumber: recordStart });
    cells = [];
    cell = '';
    recordStart = rowNumber + 1;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (inQuotes) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        cell += character;
      }
      if (character === '\r') {
        if (input[index + 1] !== '\n') rowNumber += 1;
      } else if (character === '\n') {
        rowNumber += 1;
      }
      continue;
    }

    if (closedQuote) {
      if (character === ',') {
        cells.push(cell);
        cell = '';
        closedQuote = false;
      } else if (character === '\r' || character === '\n') {
        finishRecord();
        closedQuote = false;
        if (character === '\r' && input[index + 1] === '\n') index += 1;
        rowNumber += 1;
      } else {
        throw new Error(`CSV row ${recordStart}: unexpected character after closing quote.`);
      }
      continue;
    }

    if (character === '"') {
      if (cell.length) {
        throw new Error(`CSV row ${recordStart}: quotes must start a cell.`);
      }
      inQuotes = true;
    } else if (character === ',') {
      cells.push(cell);
      cell = '';
    } else if (character === '\r' || character === '\n') {
      finishRecord();
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      rowNumber += 1;
    } else {
      cell += character;
    }
  }

  if (inQuotes) throw new Error(`CSV row ${recordStart}: unterminated quoted cell.`);
  if (closedQuote || cell.length || cells.length) finishRecord();
  return records;
}

function rowError(rowNumber: number, message: string): never {
  throw new Error(`CSV row ${rowNumber}: ${message}`);
}

export function parseReviewCsv(input: string): ReviewCsvRow[] {
  if (typeof input !== 'string') throw new Error('CSV input must be text.');
  if (new TextEncoder().encode(input).byteLength > MAX_REVIEW_CSV_BYTES) {
    throw new Error(`CSV input exceeds the ${MAX_REVIEW_CSV_BYTES}-byte limit.`);
  }

  const records = parseCsvRecords(input);
  const headerRecord = records.find(({ cells }) => cells.some((cell) => cell.length));
  if (!headerRecord) throw new Error('CSV must include a header row.');

  const headers = headerRecord.cells.map((header, index) =>
    (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim()
  );
  if (headers.some((header) => !HEADERS.has(header))) {
    const unknown = headers.find((header) => !HEADERS.has(header));
    rowError(headerRecord.rowNumber, `unknown header "${unknown}".`);
  }
  if (new Set(headers).size !== headers.length) {
    rowError(headerRecord.rowNumber, 'duplicate headers are not allowed.');
  }
  if (!headers.includes('originalReviewText')) {
    rowError(headerRecord.rowNumber, 'required header "originalReviewText" is missing.');
  }

  const dataRecords = records.filter((record) => record.rowNumber > headerRecord.rowNumber);
  const rows = dataRecords.filter(({ cells }) => cells.some((cell) => cell.length));
  if (!rows.length) throw new Error('CSV must include at least one nonblank data row.');
  if (rows.length > 100) throw new Error('CSV may include at most 100 nonblank data rows.');

  return rows.map(({ cells, rowNumber }) => {
    if (cells.length !== headers.length) {
      rowError(rowNumber, `expected ${headers.length} columns but found ${cells.length}.`);
    }
    const values = Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
    const originalReviewText = values.originalReviewText;
    const source = values.source?.trim();
    const display = values.displayAttribution?.trim();
    const allowed = values.attributionAllowed?.trim();
    const ratingText = values.rating?.trim();
    const tagsText = values.tags?.trim();

    if (!originalReviewText?.trim()) rowError(rowNumber, 'originalReviewText must not be blank.');
    if (allowed !== undefined && allowed !== '' && allowed !== 'true' && allowed !== 'false') {
      rowError(rowNumber, 'attributionAllowed must be blank, true, or false.');
    }
    if ((display && allowed !== 'true') || (!display && allowed === 'true')) {
      rowError(rowNumber, 'displayAttribution and attributionAllowed are inconsistent.');
    }
    let rating: number | undefined;
    if (ratingText) {
      rating = Number(ratingText);
      if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
        rowError(rowNumber, 'rating must be a finite number from 1 to 5.');
      }
    }
    const draft = parseReviewProofDraft({
      originalReviewText,
      ...(source ? { source } : {}),
      ...(display && allowed === 'true' ? { attribution: { display, allowed: true } } : {}),
      ...(rating !== undefined ? { rating } : {}),
      ...(tagsText ? { tags: tagsText.split('|').map((tag) => tag.trim()) } : {}),
    });
    if (!draft) rowError(rowNumber, 'contains invalid review data.');
    return { type: 'review', ...draft };
  });
}
