import { parse as parseCsvSync } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { BulkOfferRowInput } from './bulkOfferRow.types';

/**
 * Bulk Offer Import — format adapters. Each one's only job is turning a
 * file buffer into `BulkOfferRowInput[]`; neither knows anything about
 * validation, duplicates, or what happens after. Adding a new input format
 * (JSON, a REST payload, a merchant self-upload) means adding a function
 * with this same signature — nothing in bulkOfferValidation.ts or
 * BulkImportService changes.
 *
 * exceljs is used read-only (`workbook.xlsx.load`) — its `archiver`
 * dependency, which `npm audit` flags (high, via glob/minimatch), is
 * required only by exceljs's streaming XLSX WRITER
 * (lib/stream/xlsx/workbook-writer.js), a code path this file never calls.
 * Verified by inspecting exceljs's own require graph, not assumed. Its
 * `uuid` dependency (moderate, CWE-787 on v3/v5/v6 with an explicit `buf`
 * argument) is likewise only ever called by exceljs as bare `uuidv4()`
 * (lib/xform/sheet/cf-ext/cf-rule-ext-xform.js), which the advisory doesn't
 * affect at all. Deliberately not the `xlsx`/SheetJS npm package for the
 * same reason Template F's banner work avoided it — see
 * MODULE14_TEMPLATE_F_COST_SPLIT.md.
 */

// Each canonical field accepts a few header spellings — ChatGPT-generated
// exports and different admins won't always title a column identically.
// Matched after normalizeHeader() strips case/spacing/punctuation, so
// "Original Price", "original_price" and "OriginalPrice" all resolve here.
const HEADER_ALIASES: Record<
  keyof Omit<BulkOfferRowInput, 'rowNo' | 'raw'>,
  string[]
> = {
  merchantName: ['merchantname', 'businessname', 'shopname', 'merchant'],
  category: ['category'],
  offerTitle: ['offertitle', 'title'],
  offerDescription: ['offerdescription', 'description'],
  offerType: ['offertype', 'type'],
  originalPrice: ['originalprice'],
  offerPrice: ['offerprice', 'price'],
  minParticipants: [
    'minimumparticipants',
    'minparticipants',
    'participants',
    'requiredpeople',
  ],
  validFrom: ['validfrom', 'startdate'],
  validUntil: ['validuntil', 'enddate'],
  contactNumber: ['contactnumber', 'phone', 'phonenumber', 'mobile'],
  whatsappNumber: ['whatsappnumber', 'whatsapp'],
  email: ['email'],
  website: ['website'],
  address: ['address'],
  city: ['city'],
  state: ['state'],
  pincode: ['pincode', 'pin', 'zipcode', 'postalcode'],
  latitude: ['latitude', 'lat'],
  longitude: ['longitude', 'lng', 'long'],
  googleMapsLink: ['googlemapslink', 'mapslink', 'googlemaps'],
  terms: ['termsconditions', 'termsandconditions', 'terms'],
  status: ['status'],
};

function normalizeHeader(header: string): string {
  return (header || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Maps each normalized header to the canonical field it feeds, once per parse. */
function buildHeaderIndex(
  headers: string[],
): Map<number, keyof BulkOfferRowInput> {
  const index = new Map<number, keyof BulkOfferRowInput>();
  headers.forEach((header, i) => {
    const normalized = normalizeHeader(header);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(normalized)) {
        index.set(i, field as keyof BulkOfferRowInput);
        break;
      }
    }
  });
  return index;
}

// exceljs cell values are not always plain primitives — hyperlinks,
// formula results, and rich text all arrive as small objects. Each shape
// is handled explicitly and stringified from its own known-string
// property, rather than a blanket String(value) — which, for any of these
// object shapes, silently produces the useless "[object Object]" instead
// of the cell's actual text.
function toStringCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value).trim();
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text.trim(); // hyperlink cell
    if (typeof obj.result === 'string' || typeof obj.result === 'number') {
      return String(obj.result).trim(); // formula cell
    }
    if (Array.isArray(obj.richText)) {
      return obj.richText
        .map((run: unknown) =>
          typeof run === 'object' &&
          run &&
          typeof (run as Record<string, unknown>).text === 'string'
            ? ((run as Record<string, unknown>).text as string)
            : '',
        )
        .join('')
        .trim();
    }
  }
  return ''; // an unrecognised cell shape (e.g. a formula error) — empty beats a misleading "[object Object]"
}

function emptyRow(rowNo: number): BulkOfferRowInput {
  return {
    rowNo,
    merchantName: '',
    category: '',
    offerTitle: '',
    offerDescription: '',
    offerType: '',
    originalPrice: '',
    offerPrice: '',
    minParticipants: '',
    validFrom: '',
    validUntil: '',
    contactNumber: '',
    whatsappNumber: '',
    email: '',
    website: '',
    address: '',
    city: '',
    state: '',
    pincode: '',
    latitude: '',
    longitude: '',
    googleMapsLink: '',
    terms: '',
    status: '',
    raw: {},
  };
}

export function parseCsvRows(buffer: Buffer): BulkOfferRowInput[] {
  const records: string[][] = parseCsvSync(buffer, {
    skip_empty_lines: true,
    relax_column_count: true,
  });
  if (records.length === 0) return [];

  const [headerRow, ...dataRows] = records;
  const headerIndex = buildHeaderIndex(headerRow);

  return dataRows.map((cells, i) => {
    const row = emptyRow(i + 1);
    const raw: Record<string, unknown> = {};
    cells.forEach((cell, colIdx) => {
      const header = headerRow[colIdx] ?? `column_${colIdx + 1}`;
      raw[header] = cell;
      const field = headerIndex.get(colIdx);
      if (field && field !== 'rowNo' && field !== 'raw') {
        (row as unknown as Record<string, string>)[field] = toStringCell(cell);
      }
    });
    row.raw = raw;
    return row;
  });
}

export async function parseXlsxRows(
  buffer: Buffer,
): Promise<BulkOfferRowInput[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber - 1] = toStringCell(cell.value);
  });
  const headerIndex = buildHeaderIndex(headers);

  const rows: BulkOfferRowInput[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const excelRow = sheet.getRow(r);
    if (excelRow.cellCount === 0) continue;
    const row = emptyRow(r - 1);
    const raw: Record<string, unknown> = {};
    let hasContent = false;
    excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const value = toStringCell(cell.value);
      const header = headers[colNumber - 1] ?? `column_${colNumber}`;
      raw[header] = value;
      if (value) hasContent = true;
      const field = headerIndex.get(colNumber - 1);
      if (field && field !== 'rowNo' && field !== 'raw') {
        (row as unknown as Record<string, string>)[field] = value;
      }
    });
    if (!hasContent) continue; // skip fully blank rows (trailing sheet padding)
    row.raw = raw;
    rows.push(row);
  }
  return rows;
}

export type ParsedSpreadsheetFormat = 'csv' | 'xlsx';

/** Dispatches on the uploaded file's declared type. FileValidationService has already confirmed the magic bytes match before this is called. */
export async function parseOfferRows(
  buffer: Buffer,
  format: ParsedSpreadsheetFormat,
): Promise<BulkOfferRowInput[]> {
  return format === 'csv' ? parseCsvRows(buffer) : parseXlsxRows(buffer);
}
