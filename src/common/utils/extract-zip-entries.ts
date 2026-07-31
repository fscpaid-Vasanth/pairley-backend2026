import * as unzipper from 'unzipper';

export interface ExtractedZipEntry {
  fileName: string;
  buffer: Buffer;
  mimetype: string;
}

/**
 * ZIP entries carry no Content-Type — this is the same extension-based
 * guess bulk-import's image upload always used, kept here so every ZIP
 * consumer agrees on it rather than re-deriving it.
 */
function guessImageMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Extracts every file entry from a ZIP buffer (directory entries skipped).
 * Shared by every admin-facing bulk-image path (bulk-import, Offer
 * Publisher) so the extraction + MIME-guessing logic exists exactly once.
 *
 * A ZIP entry's path commonly carries a folder prefix (e.g.
 * "images/OFF000123.jpg") — only the basename is meaningful to any of this
 * codebase's filename-based matching, so that's all this returns.
 */
export async function extractZipEntries(
  zipBuffer: Buffer,
): Promise<ExtractedZipEntry[]> {
  const directory = await unzipper.Open.buffer(zipBuffer);
  const entries: ExtractedZipEntry[] = [];

  for (const entry of directory.files) {
    if (entry.type !== 'File') continue;
    const fileName = entry.path.split('/').pop() ?? entry.path;
    if (!fileName) continue;

    const buffer = await entry.buffer();
    entries.push({
      fileName,
      buffer,
      mimetype: guessImageMimeType(fileName),
    });
  }

  return entries;
}
