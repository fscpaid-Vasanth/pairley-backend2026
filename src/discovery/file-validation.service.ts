import { Injectable } from '@nestjs/common';
import * as path from 'path';
import { FileImportError } from './file-import.errors';

// 15MB — the "real" acceptable limit, enforced here (not just at the Multer
// layer) so an oversized-but-received upload produces a clear FAILED
// ImportJob rather than only a bare transport-level rejection. The
// controller's Multer config sets a higher hard ceiling (20MB) purely as a
// blunt DoS guard — a file between these two limits is the case this
// service's check actually catches.
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;

interface FileSignature {
  mime: string;
  check: (buf: Buffer) => boolean;
}

// Magic-byte signatures, checked against the actual buffer — never trust
// the client-declared Content-Type header alone, since it's trivially
// spoofable (Decision 5: "file signature validation where practical").
const SIGNATURES: FileSignature[] = [
  {
    mime: 'image/jpeg',
    check: (b) =>
      b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/png',
    check: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    mime: 'image/webp',
    check: (b) =>
      b.length >= 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    mime: 'application/pdf',
    check: (b) => b.length >= 5 && b.toString('ascii', 0, 5) === '%PDF-',
  },
];

const ALLOWED_MIME_TYPES = SIGNATURES.map((s) => s.mime);

@Injectable()
export class FileValidationService {
  validate(file: { mimetype: string; size: number; buffer: Buffer }): void {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new FileImportError(
        `Unsupported file type: ${file.mimetype}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`,
        'INVALID_FILE_TYPE',
      );
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new FileImportError(
        `File exceeds the maximum allowed size of ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB`,
        'FILE_TOO_LARGE',
      );
    }

    const matched = SIGNATURES.find((s) => s.check(file.buffer));
    if (!matched) {
      throw new FileImportError(
        'File content does not match any supported format (signature check failed)',
        'INVALID_FILE_SIGNATURE',
      );
    }
    if (matched.mime !== file.mimetype) {
      throw new FileImportError(
        `Declared file type (${file.mimetype}) does not match actual file content (detected ${matched.mime})`,
        'FILE_TYPE_MISMATCH',
      );
    }
  }

  // Never trust the client-supplied original filename directly in a
  // storage key or log line — strips it to a safe, bounded charset.
  // StorageService.uploadFile() already applies path.basename() as a second
  // layer, but building a genuinely safe name here (not just
  // traversal-safe) is cheap and removes an entire class of encoding/
  // injection edge cases before the name goes anywhere near S3 or a log.
  sanitizeFilename(originalName: string): string {
    const ext = path
      .extname(originalName)
      .toLowerCase()
      .replace(/[^a-z0-9.]/g, '');
    const rawBase = path
      .basename(originalName, path.extname(originalName))
      .replace(/[^a-zA-Z0-9-_]/g, '_')
      .slice(0, 60);
    // A name that sanitized down to nothing but underscores had no usable
    // characters to begin with (e.g. "???.jpg") — a generic default is
    // more honest than a name made entirely of placeholder characters.
    const base = /[a-zA-Z0-9]/.test(rawBase) ? rawBase : '';
    return `${base || 'upload'}${ext}`;
  }
}
