// Minimal RFC-4180-ish CSV parser. Handles:
//   - quoted fields with embedded commas
//   - escaped quotes ("") inside quoted fields
//   - CRLF or LF line endings
//   - leading BOM
// We deliberately avoid pulling in papaparse for v0.1 — dealer CSVs are small
// (a few hundred rows) and our schema is fixed.

export type CsvRow = Record<string, string>;

// Hard ceiling enforced inside parseCsv. The dealer-side action also
// rejects > 5MB files before they reach us; this is belt-and-braces
// so a tiny file with millions of empty rows still bounces.
export const CSV_MAX_DATA_ROWS = 5000;

export class CsvTooLargeError extends Error {
  constructor(public readonly rows: number) {
    super(`CSV has too many rows (limit ${CSV_MAX_DATA_ROWS}, got ${rows}+)`);
    this.name = "CsvTooLargeError";
  }
}

const STATE_FIELD_START = 0;
const STATE_IN_FIELD = 1;
const STATE_IN_QUOTES = 2;
const STATE_AFTER_QUOTES = 3;

function tokenize(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let state = STATE_FIELD_START;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (state === STATE_IN_QUOTES) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          state = STATE_AFTER_QUOTES;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && (state === STATE_FIELD_START || state === STATE_IN_FIELD)) {
      // A quote in the middle of an unquoted field is treated as literal.
      if (state === STATE_FIELD_START) {
        state = STATE_IN_QUOTES;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      state = STATE_FIELD_START;
      continue;
    }

    if (ch === "\r") {
      // Swallow; the following \n will end the row.
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      state = STATE_FIELD_START;
      continue;
    }

    if (state === STATE_AFTER_QUOTES) {
      // Stray characters after a closing quote — treat as literal.
      field += ch;
      state = STATE_IN_FIELD;
      continue;
    }

    field += ch;
    if (state === STATE_FIELD_START) state = STATE_IN_FIELD;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function parseCsv(input: string): CsvRow[] {
  const rows = tokenize(input);
  if (rows.length === 0) return [];
  // rows[0] is the header. Cap data rows at CSV_MAX_DATA_ROWS.
  if (rows.length - 1 > CSV_MAX_DATA_ROWS) {
    throw new CsvTooLargeError(rows.length - 1);
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((cells) => {
    const out: CsvRow = {};
    for (let i = 0; i < header.length; i += 1) {
      out[header[i]] = (cells[i] ?? "").trim();
    }
    return out;
  });
}
