import { FileValidationService } from './file-validation.service';
import { FileImportError } from './file-import.errors';

// Minimal real magic bytes for each format — not full valid files, just
// enough to exercise the signature check honestly rather than mocking it.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'),
]);
const PDF_BYTES = Buffer.from('%PDF-1.4\n%something', 'ascii');
const TEXT_BYTES = Buffer.from(
  'just some plain text, not a real file',
  'ascii',
);

describe('FileValidationService', () => {
  const service = new FileValidationService();

  describe('validate()', () => {
    it('accepts a real JPEG', () => {
      expect(() =>
        service.validate({
          mimetype: 'image/jpeg',
          size: JPEG_BYTES.length,
          buffer: JPEG_BYTES,
        }),
      ).not.toThrow();
    });

    it('accepts a real PNG', () => {
      expect(() =>
        service.validate({
          mimetype: 'image/png',
          size: PNG_BYTES.length,
          buffer: PNG_BYTES,
        }),
      ).not.toThrow();
    });

    it('accepts a real WebP', () => {
      expect(() =>
        service.validate({
          mimetype: 'image/webp',
          size: WEBP_BYTES.length,
          buffer: WEBP_BYTES,
        }),
      ).not.toThrow();
    });

    it('accepts a real text-layer-shaped PDF', () => {
      expect(() =>
        service.validate({
          mimetype: 'application/pdf',
          size: PDF_BYTES.length,
          buffer: PDF_BYTES,
        }),
      ).not.toThrow();
    });

    it('rejects an unsupported declared mimetype with INVALID_FILE_TYPE', () => {
      expect(() =>
        service.validate({
          mimetype: 'application/x-msdownload',
          size: 10,
          buffer: JPEG_BYTES,
        }),
      ).toThrow(FileImportError);
      try {
        service.validate({
          mimetype: 'application/x-msdownload',
          size: 10,
          buffer: JPEG_BYTES,
        });
      } catch (err) {
        expect((err as FileImportError).reason).toBe('INVALID_FILE_TYPE');
      }
    });

    it('rejects an oversized file with FILE_TOO_LARGE', () => {
      const oversized = Buffer.concat([
        JPEG_BYTES,
        Buffer.alloc(16 * 1024 * 1024),
      ]);
      try {
        service.validate({
          mimetype: 'image/jpeg',
          size: oversized.length,
          buffer: oversized,
        });
        throw new Error('expected validate() to throw');
      } catch (err) {
        expect((err as FileImportError).reason).toBe('FILE_TOO_LARGE');
      }
    });

    it('rejects content whose bytes match no known signature with INVALID_FILE_SIGNATURE', () => {
      try {
        service.validate({
          mimetype: 'image/jpeg',
          size: TEXT_BYTES.length,
          buffer: TEXT_BYTES,
        });
        throw new Error('expected validate() to throw');
      } catch (err) {
        expect((err as FileImportError).reason).toBe('INVALID_FILE_SIGNATURE');
      }
    });

    it('rejects a declared/actual mimetype mismatch with FILE_TYPE_MISMATCH (spoofing protection)', () => {
      // Real PNG bytes, but declared as a PDF — a classic Content-Type spoof.
      try {
        service.validate({
          mimetype: 'application/pdf',
          size: PNG_BYTES.length,
          buffer: PNG_BYTES,
        });
        throw new Error('expected validate() to throw');
      } catch (err) {
        expect((err as FileImportError).reason).toBe('FILE_TYPE_MISMATCH');
      }
    });
  });

  describe('sanitizeFilename()', () => {
    it('strips path-traversal segments', () => {
      expect(service.sanitizeFilename('../../etc/passwd.jpg')).not.toContain(
        '..',
      );
      expect(service.sanitizeFilename('../../etc/passwd.jpg')).not.toContain(
        '/',
      );
    });

    it('replaces unsafe characters and preserves a reasonable extension', () => {
      const result = service.sanitizeFilename(
        'my offer poster #1 (final)!.png',
      );
      expect(result.endsWith('.png')).toBe(true);
      expect(result).toMatch(/^[a-zA-Z0-9-_.]+$/);
    });

    it('caps an unreasonably long filename', () => {
      const result = service.sanitizeFilename(`${'a'.repeat(300)}.jpg`);
      expect(result.length).toBeLessThanOrEqual(64);
    });

    it('falls back to a safe default when the name has no usable characters', () => {
      const result = service.sanitizeFilename('???.jpg');
      expect(result.startsWith('upload')).toBe(true);
    });
  });
});
