import ExcelJS from 'exceljs';
import {
  parseCsvRows,
  parseXlsxRows,
  parseOfferRows,
} from './bulkOfferParsers';

const HEADERS = [
  'Merchant Name',
  'Category',
  'Offer Title',
  'Offer Description',
  'Offer Type',
  'Original Price',
  'Offer Price',
  'Minimum Participants',
  'Valid From',
  'Valid Until',
  'Contact Number',
  'WhatsApp Number',
  'Email',
  'Website',
  'Address',
  'City',
  'State',
  'Pincode',
  'Latitude',
  'Longitude',
  'Google Maps Link',
  'Terms & Conditions',
  'Status',
];

const SAMPLE_ROW = [
  'Spec Gym',
  'Fitness',
  '6 Month Pass',
  'Great deal',
  'STANDARD',
  '5000',
  '3000',
  '1',
  '2026-08-01',
  '2026-08-31',
  '9876543210',
  '',
  '',
  '',
  '123 Main St',
  'Bangalore',
  'Karnataka',
  '560001',
  '',
  '',
  '',
  '',
  '',
];

function toCsv(rows: string[][]): Buffer {
  const escape = (v: string) => (v.includes(',') ? `"${v}"` : v);
  return Buffer.from(
    rows.map((r) => r.map(escape).join(',')).join('\n'),
    'utf8',
  );
}

describe('parseCsvRows', () => {
  it('parses a well-formed CSV into row inputs', () => {
    const rows = parseCsvRows(toCsv([HEADERS, SAMPLE_ROW]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rowNo: 1,
      merchantName: 'Spec Gym',
      offerTitle: '6 Month Pass',
      offerType: 'STANDARD',
      originalPrice: '5000',
      offerPrice: '3000',
      contactNumber: '9876543210',
      city: 'Bangalore',
    });
  });

  it('recognises alternate header spellings', () => {
    const altHeaders = HEADERS.map((h) =>
      h === 'Merchant Name'
        ? 'business_name'
        : h === 'Offer Price'
          ? 'price'
          : h,
    );
    const rows = parseCsvRows(toCsv([altHeaders, SAMPLE_ROW]));
    expect(rows[0].merchantName).toBe('Spec Gym');
    expect(rows[0].offerPrice).toBe('3000');
  });

  it('numbers rows starting at 1, matching the sheet’s data rows', () => {
    const rows = parseCsvRows(toCsv([HEADERS, SAMPLE_ROW, SAMPLE_ROW]));
    expect(rows.map((r) => r.rowNo)).toEqual([1, 2]);
  });

  it('preserves the original row for the error report', () => {
    const rows = parseCsvRows(toCsv([HEADERS, SAMPLE_ROW]));
    expect(rows[0].raw['Merchant Name']).toBe('Spec Gym');
  });

  it('returns an empty array for a header-only file', () => {
    expect(parseCsvRows(toCsv([HEADERS]))).toEqual([]);
  });

  it('returns an empty array for a completely empty file', () => {
    expect(parseCsvRows(Buffer.from(''))).toEqual([]);
  });

  it('does not choke on a row shorter than the header (relax_column_count)', () => {
    const shortRow = SAMPLE_ROW.slice(0, 5);
    expect(() => parseCsvRows(toCsv([HEADERS, shortRow]))).not.toThrow();
  });
});

async function toXlsx(headers: string[], rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Offers');
  sheet.addRow(headers);
  rows.forEach((r) => sheet.addRow(r));
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

describe('parseXlsxRows', () => {
  it('parses a well-formed workbook into row inputs', async () => {
    const buffer = await toXlsx(HEADERS, [SAMPLE_ROW]);
    const rows = await parseXlsxRows(buffer);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rowNo: 1,
      merchantName: 'Spec Gym',
      offerTitle: '6 Month Pass',
      contactNumber: '9876543210',
    });
  });

  it('skips fully blank trailing rows', async () => {
    const buffer = await toXlsx(HEADERS, [SAMPLE_ROW, HEADERS.map(() => '')]);
    const rows = await parseXlsxRows(buffer);
    expect(rows).toHaveLength(1);
  });

  it('returns an empty array for a workbook with no worksheets', async () => {
    const workbook = new ExcelJS.Workbook();
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await parseXlsxRows(buffer)).toEqual([]);
  });
});

describe('parseOfferRows', () => {
  it('dispatches to the CSV parser', async () => {
    const rows = await parseOfferRows(toCsv([HEADERS, SAMPLE_ROW]), 'csv');
    expect(rows[0].merchantName).toBe('Spec Gym');
  });

  it('dispatches to the XLSX parser', async () => {
    const buffer = await toXlsx(HEADERS, [SAMPLE_ROW]);
    const rows = await parseOfferRows(buffer, 'xlsx');
    expect(rows[0].merchantName).toBe('Spec Gym');
  });
});
