import { FileImportError } from '../discovery/file-import.errors';
import { ParsedSpreadsheetFormat } from './bulkOfferParsers';

/**
 * Bulk Offer Import — validates the uploaded spreadsheet itself, before any
 * parsing is attempted. A companion to FileValidationService, not a
 * replacement: that service's magic-byte SIGNATURES cover JPEG/PNG/WEBP/PDF
 * only (and is reused as-is for Bulk Image Upload — see
 * bulk-image-import.service.ts), none of which apply to CSV/XLSX.
 *
 * XLSX gets a real signature check — it's a ZIP archive, so `PK\x03\x04` (or
 * `PK\x05\x06` for an empty one) at the start of the buffer is a genuine,
 * spoofing-resistant test, the same discipline as every other upload path
 * in this codebase. CSV has no such signature — it's plain text — so its
 * only trust check possible here is size, and its real validation is
 * whether it actually parses into offer rows (see BulkImportService),
 * which surfaces as a batch-level FAILED status with a clear reason rather
 * than a generic rejection here.
 */

// 25MB — generous for a text/zip-based spreadsheet (10,000 rows is a few
// MB at most even with XLSX's overhead), but still a bound, matching the
// spirit of FileValidationService's own ceiling for images.
const MAX_SHEET_SIZE_BYTES = 25 * 1024 * 1024;

const XLSX_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];
const CSV_MIME_TYPES = [
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
];

function isZipSignature(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const isLocalFileHeader =
    buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const isEmptyArchive =
    buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x05 && buf[3] === 0x06;
  return isLocalFileHeader || isEmptyArchive;
}

export interface SheetFileInput {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Returns the detected format, or throws a FileImportError with a machine-readable reason. */
export function validateSheetFile(
  file: SheetFileInput,
): ParsedSpreadsheetFormat {
  if (file.size > MAX_SHEET_SIZE_BYTES) {
    throw new FileImportError(
      `File exceeds the maximum allowed size of ${MAX_SHEET_SIZE_BYTES / (1024 * 1024)}MB`,
      'FILE_TOO_LARGE',
    );
  }

  const ext = file.originalname.toLowerCase().split('.').pop() ?? '';
  const looksLikeXlsx =
    ext === 'xlsx' || XLSX_MIME_TYPES.includes(file.mimetype);
  const looksLikeCsv = ext === 'csv' || CSV_MIME_TYPES.includes(file.mimetype);

  if (looksLikeXlsx) {
    if (!isZipSignature(file.buffer)) {
      throw new FileImportError(
        'File content does not match the XLSX format (signature check failed)',
        'INVALID_FILE_SIGNATURE',
      );
    }
    return 'xlsx';
  }

  if (looksLikeCsv) {
    return 'csv';
  }

  throw new FileImportError(
    `Unsupported file type: expected .csv or .xlsx, got "${file.originalname}"`,
    'INVALID_FILE_TYPE',
  );
}
