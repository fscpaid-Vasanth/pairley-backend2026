import { Injectable } from '@nestjs/common';
import pdfParse from 'pdf-parse';
import { FileImportError } from './file-import.errors';

// A PDF with less text than this is treated as having no meaningful text
// layer — i.e. a scanned/image-only PDF, out of scope for Module 10 per
// the approved Decision 4 (fails gracefully with a clear reason rather
// than attempting a risky page-rasterization fallback).
const MIN_MEANINGFUL_TEXT_LENGTH = 20;

@Injectable()
export class PdfTextService {
  async extractText(buffer: Buffer): Promise<string> {
    let result: { text: string };
    try {
      result = await pdfParse(buffer);
    } catch (err) {
      throw new FileImportError(
        `Failed to parse PDF: ${err instanceof Error ? err.message : 'unknown error'}`,
        'PDF_PARSE_FAILED',
      );
    }

    const text = (result.text || '').trim();
    if (text.length < MIN_MEANINGFUL_TEXT_LENGTH) {
      throw new FileImportError(
        'PDF has no extractable text layer — likely a scanned/image-only PDF, which is out of scope (try re-uploading as an image instead)',
        'UNSUPPORTED_SCANNED_PDF',
      );
    }
    return text;
  }
}
