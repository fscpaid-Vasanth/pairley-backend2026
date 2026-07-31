import { validateSheetFile } from './sheetFileValidation';
import { FileImportError } from '../discovery/file-import.errors';

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

describe('validateSheetFile', () => {
  it('accepts a genuine XLSX file', () => {
    expect(
      validateSheetFile({
        originalname: 'offers.xlsx',
        mimetype:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: XLSX_MAGIC.length,
        buffer: XLSX_MAGIC,
      }),
    ).toBe('xlsx');
  });

  it('rejects a file named .xlsx whose content is not actually a ZIP', () => {
    expect(() =>
      validateSheetFile({
        originalname: 'offers.xlsx',
        mimetype:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 10,
        buffer: Buffer.from('not a zip!'),
      }),
    ).toThrow(FileImportError);
  });

  it('accepts a CSV file by extension, with no magic-byte requirement', () => {
    const buf = Buffer.from('Merchant Name,Category\nSpec Gym,Fitness');
    expect(
      validateSheetFile({
        originalname: 'offers.csv',
        mimetype: 'text/csv',
        size: buf.length,
        buffer: buf,
      }),
    ).toBe('csv');
  });

  it('rejects an unrelated file type', () => {
    expect(() =>
      validateSheetFile({
        originalname: 'photo.jpg',
        mimetype: 'image/jpeg',
        size: 100,
        buffer: Buffer.from([0xff, 0xd8, 0xff]),
      }),
    ).toThrow(FileImportError);
  });

  it('rejects an oversized file', () => {
    expect(() =>
      validateSheetFile({
        originalname: 'offers.csv',
        mimetype: 'text/csv',
        size: 26 * 1024 * 1024,
        buffer: Buffer.from('x'),
      }),
    ).toThrow(/maximum allowed size/);
  });
});
