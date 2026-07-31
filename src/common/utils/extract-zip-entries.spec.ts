import archiver from 'archiver';
import { extractZipEntries } from './extract-zip-entries';

/** Builds a real ZIP buffer (via `archiver`) so this test round-trips
 * through the actual `unzipper` parsing path, not a mock of it. */
function buildZip(
  entries: { name: string; content: string }[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip');
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const e of entries) {
      archive.append(Buffer.from(e.content), { name: e.name });
    }
    void archive.finalize();
  });
}

describe('extractZipEntries', () => {
  it('extracts every file entry with its buffer contents', async () => {
    const zip = await buildZip([
      { name: 'OFF000001.jpg', content: 'hero-bytes' },
      { name: 'OFF000001_1.jpg', content: 'gallery-bytes' },
    ]);

    const entries = await extractZipEntries(zip);

    expect(entries).toHaveLength(2);
    expect(entries[0].fileName).toBe('OFF000001.jpg');
    expect(entries[0].buffer.toString()).toBe('hero-bytes');
    expect(entries[1].fileName).toBe('OFF000001_1.jpg');
  });

  it('strips a folder prefix down to the basename', async () => {
    const zip = await buildZip([
      { name: 'images/nested/OFF000005.png', content: 'x' },
    ]);
    const entries = await extractZipEntries(zip);
    expect(entries[0].fileName).toBe('OFF000005.png');
  });

  it('guesses the MIME type from the extension, defaulting to octet-stream for unknown ones', async () => {
    const zip = await buildZip([
      { name: 'a.jpg', content: 'x' },
      { name: 'b.jpeg', content: 'x' },
      { name: 'c.png', content: 'x' },
      { name: 'd.webp', content: 'x' },
      { name: 'e.txt', content: 'x' },
    ]);
    const entries = await extractZipEntries(zip);
    const byName = Object.fromEntries(
      entries.map((e) => [e.fileName, e.mimetype]),
    );
    expect(byName['a.jpg']).toBe('image/jpeg');
    expect(byName['b.jpeg']).toBe('image/jpeg');
    expect(byName['c.png']).toBe('image/png');
    expect(byName['d.webp']).toBe('image/webp');
    expect(byName['e.txt']).toBe('application/octet-stream');
  });

  it('returns an empty array for a ZIP with no file entries', async () => {
    const zip = await buildZip([]);
    const entries = await extractZipEntries(zip);
    expect(entries).toEqual([]);
  });
});
