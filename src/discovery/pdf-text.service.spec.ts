const pdfParseMock = jest.fn();
jest.mock('pdf-parse', () => ({
  __esModule: true,
  default: (...args: unknown[]): unknown => pdfParseMock(...args),
}));

import { PdfTextService } from './pdf-text.service';
import { FileImportError } from './file-import.errors';

describe('PdfTextService', () => {
  let service: PdfTextService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PdfTextService();
  });

  it('returns the extracted text for a PDF with a real text layer', async () => {
    pdfParseMock.mockResolvedValue({
      text: 'Diwali Mega Sale — flat 40% off storewide, valid till 31 Oct',
    });

    const result = await service.extractText(Buffer.from('fake-pdf-bytes'));

    expect(result).toBe(
      'Diwali Mega Sale — flat 40% off storewide, valid till 31 Oct',
    );
  });

  it('throws UNSUPPORTED_SCANNED_PDF when the extracted text is too short to be meaningful', async () => {
    pdfParseMock.mockResolvedValue({ text: '  \n ' });

    try {
      await service.extractText(Buffer.from('fake-pdf-bytes'));
      throw new Error('expected extractText() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FileImportError);
      expect((err as FileImportError).reason).toBe('UNSUPPORTED_SCANNED_PDF');
    }
  });

  it('throws UNSUPPORTED_SCANNED_PDF when pdf-parse returns no text field at all', async () => {
    pdfParseMock.mockResolvedValue({});

    try {
      await service.extractText(Buffer.from('fake-pdf-bytes'));
      throw new Error('expected extractText() to throw');
    } catch (err) {
      expect((err as FileImportError).reason).toBe('UNSUPPORTED_SCANNED_PDF');
    }
  });

  it('wraps a pdf-parse crash as PDF_PARSE_FAILED', async () => {
    pdfParseMock.mockRejectedValue(new Error('Invalid PDF structure'));

    try {
      await service.extractText(Buffer.from('not-really-a-pdf'));
      throw new Error('expected extractText() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FileImportError);
      expect((err as FileImportError).reason).toBe('PDF_PARSE_FAILED');
      expect((err as FileImportError).message).toContain(
        'Invalid PDF structure',
      );
    }
  });
});
