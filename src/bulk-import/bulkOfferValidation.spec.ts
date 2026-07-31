import {
  validateBulkOfferRow,
  findDuplicateRowIndexes,
} from './bulkOfferValidation';
import { BulkOfferRowInput } from './bulkOfferRow.types';

function makeRow(
  overrides: Partial<BulkOfferRowInput> = {},
): BulkOfferRowInput {
  return {
    rowNo: 1,
    merchantName: 'Spec Gym',
    category: 'Fitness',
    offerTitle: '6 Month Pass',
    offerDescription: 'Great deal',
    offerType: 'STANDARD',
    originalPrice: '5000',
    offerPrice: '3000',
    minParticipants: '1',
    validFrom: '2026-08-01',
    validUntil: '2026-08-31',
    contactNumber: '9876543210',
    whatsappNumber: '',
    email: '',
    website: '',
    address: '123 Main St',
    city: 'Bangalore',
    state: 'Karnataka',
    pincode: '560001',
    latitude: '',
    longitude: '',
    googleMapsLink: '',
    terms: '',
    status: '',
    raw: {},
    ...overrides,
  };
}

describe('validateBulkOfferRow', () => {
  it('accepts a fully valid row', () => {
    const result = validateBulkOfferRow(makeRow());
    expect(result.status).toBe('VALID');
    expect(result.errors).toEqual([]);
    expect(result.normalized).toMatchObject({
      merchantName: 'Spec Gym',
      title: '6 Month Pass',
      offerType: 'STANDARD',
      originalPrice: 5000,
      offerPrice: 3000,
      requiredPeople: 1,
      mobile: '9876543210',
    });
  });

  describe('required fields', () => {
    it.each([
      ['merchantName', 'Merchant Name'],
      ['category', 'Category'],
      ['offerTitle', 'Offer Title'],
      ['address', 'Address'],
      ['city', 'City'],
      ['state', 'State'],
      ['pincode', 'Pincode'],
    ])('rejects a missing %s', (field, label) => {
      const result = validateBulkOfferRow(makeRow({ [field]: '' }));
      expect(result.status).toBe('INVALID');
      expect(result.errors.some((e) => e.includes(label))).toBe(true);
    });
  });

  describe('pincode', () => {
    it('rejects a pincode that is not 6 digits', () => {
      expect(validateBulkOfferRow(makeRow({ pincode: '5600' })).status).toBe(
        'INVALID',
      );
      expect(validateBulkOfferRow(makeRow({ pincode: 'abcdef' })).status).toBe(
        'INVALID',
      );
    });

    it('accepts a valid 6-digit pincode', () => {
      const result = validateBulkOfferRow(makeRow({ pincode: '560001' }));
      expect(result.status).toBe('VALID');
      expect(result.normalized?.pincode).toBe('560001');
    });
  });

  it('rejects an unrecognised offer type', () => {
    const result = validateBulkOfferRow(makeRow({ offerType: 'NOT_A_TYPE' }));
    expect(result.status).toBe('INVALID');
    expect(
      result.errors.some((e) => e.includes('not a recognised offer type')),
    ).toBe(true);
  });

  it('accepts offer type case/spacing variations', () => {
    expect(
      validateBulkOfferRow(makeRow({ offerType: 'group discount' })).status,
    ).toBe('VALID');
    expect(
      validateBulkOfferRow(makeRow({ offerType: 'Group-Discount' })).status,
    ).toBe('VALID');
    expect(
      validateBulkOfferRow(makeRow({ offerType: 'group_discount' })).status,
    ).toBe('VALID');
  });

  describe('prices', () => {
    it('rejects a non-numeric price', () => {
      expect(
        validateBulkOfferRow(makeRow({ originalPrice: 'abc' })).status,
      ).toBe('INVALID');
    });

    it('rejects a zero or negative price', () => {
      expect(validateBulkOfferRow(makeRow({ offerPrice: '0' })).status).toBe(
        'INVALID',
      );
      expect(validateBulkOfferRow(makeRow({ offerPrice: '-100' })).status).toBe(
        'INVALID',
      );
    });

    // The exact bug MODULE14_TEMPLATE_F_COST_SPLIT.md found in the banner
    // engine: an offer that doesn't actually save the customer money.
    it('rejects an offer price that is not lower than the original', () => {
      const result = validateBulkOfferRow(
        makeRow({ originalPrice: '1000', offerPrice: '1000' }),
      );
      expect(result.status).toBe('INVALID');
      expect(result.errors.some((e) => e.includes('lower than'))).toBe(true);
    });

    // The exact threshold from the Module 15 production audit — flagged
    // both real bad-data rows there with zero false positives.
    it('warns but does not reject a discount of 70% or more', () => {
      const result = validateBulkOfferRow(
        makeRow({ originalPrice: '10000', offerPrice: '2000' }),
      );
      expect(result.status).toBe('VALID');
      expect(result.warnings.some((w) => w.includes('80%'))).toBe(true);
    });

    it('does not warn on an ordinary discount', () => {
      const result = validateBulkOfferRow(
        makeRow({ originalPrice: '1000', offerPrice: '800' }),
      );
      expect(result.status).toBe('VALID');
      expect(result.warnings).toEqual([]);
    });
  });

  describe('participants', () => {
    it('rejects zero or a fraction', () => {
      expect(
        validateBulkOfferRow(makeRow({ minParticipants: '0' })).status,
      ).toBe('INVALID');
      expect(
        validateBulkOfferRow(makeRow({ minParticipants: '2.5' })).status,
      ).toBe('INVALID');
    });
  });

  describe('dates', () => {
    it('rejects an unparseable date', () => {
      expect(
        validateBulkOfferRow(makeRow({ validFrom: 'not a date' })).status,
      ).toBe('INVALID');
    });

    it('rejects Valid Until on or before Valid From', () => {
      const result = validateBulkOfferRow(
        makeRow({ validFrom: '2026-08-31', validUntil: '2026-08-01' }),
      );
      expect(result.status).toBe('INVALID');
      expect(result.errors.some((e) => e.includes('after Valid From'))).toBe(
        true,
      );
    });
  });

  describe('contact fields', () => {
    it('rejects a malformed contact number', () => {
      expect(
        validateBulkOfferRow(makeRow({ contactNumber: '123' })).status,
      ).toBe('INVALID');
    });

    it('strips formatting characters before checking digit count', () => {
      const result = validateBulkOfferRow(
        makeRow({ contactNumber: '+91 98765-43210' }),
      );
      expect(result.status).toBe('VALID');
      expect(result.normalized?.mobile).toBe('919876543210');
    });

    it('rejects a malformed WhatsApp number when supplied', () => {
      expect(
        validateBulkOfferRow(makeRow({ whatsappNumber: '123' })).status,
      ).toBe('INVALID');
    });

    it('allows an absent WhatsApp number', () => {
      expect(validateBulkOfferRow(makeRow({ whatsappNumber: '' })).status).toBe(
        'VALID',
      );
    });

    it('rejects a malformed email when supplied', () => {
      expect(
        validateBulkOfferRow(makeRow({ email: 'not-an-email' })).status,
      ).toBe('INVALID');
    });

    it('allows an absent email', () => {
      expect(validateBulkOfferRow(makeRow({ email: '' })).status).toBe('VALID');
    });
  });

  describe('location', () => {
    it('allows both latitude and longitude absent', () => {
      expect(
        validateBulkOfferRow(makeRow({ latitude: '', longitude: '' })).status,
      ).toBe('VALID');
    });

    // Half a coordinate pair is worse than none — it would silently place a
    // pin at (0, lng) or (lat, 0) rather than showing no map at all.
    it('rejects latitude without longitude', () => {
      const result = validateBulkOfferRow(
        makeRow({ latitude: '12.9', longitude: '' }),
      );
      expect(result.status).toBe('INVALID');
      expect(result.errors.some((e) => e.includes('both be provided'))).toBe(
        true,
      );
    });

    it('rejects an out-of-range coordinate', () => {
      expect(
        validateBulkOfferRow(makeRow({ latitude: '200', longitude: '77' }))
          .status,
      ).toBe('INVALID');
    });

    it('accepts a valid coordinate pair', () => {
      const result = validateBulkOfferRow(
        makeRow({ latitude: '12.9716', longitude: '77.5946' }),
      );
      expect(result.status).toBe('VALID');
      expect(result.normalized?.geoLat).toBeCloseTo(12.9716);
      expect(result.normalized?.geoLng).toBeCloseTo(77.5946);
    });
  });

  it('accumulates every violated rule, not just the first', () => {
    const result = validateBulkOfferRow(
      makeRow({ merchantName: '', offerPrice: '0', contactNumber: '' }),
    );
    expect(result.status).toBe('INVALID');
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('findDuplicateRowIndexes', () => {
  it('flags the second of two rows with the same merchant/city/title', () => {
    const dupes = findDuplicateRowIndexes([
      {
        rowNo: 1,
        normalized: {
          merchantName: 'Spec Gym',
          city: 'Bangalore',
          title: '6 Month Pass',
        },
      },
      {
        rowNo: 2,
        normalized: {
          merchantName: 'The Big Barbeque',
          city: 'Chennai',
          title: 'Buffet',
        },
      },
      {
        rowNo: 3,
        normalized: {
          merchantName: 'Spec Gym',
          city: 'Bangalore',
          title: '6 Month Pass',
        },
      },
    ]);
    expect(dupes).toEqual(new Set([3]));
  });

  it('is case- and whitespace-insensitive', () => {
    const dupes = findDuplicateRowIndexes([
      {
        rowNo: 1,
        normalized: {
          merchantName: 'Spec Gym',
          city: 'Bangalore',
          title: '6 Month Pass',
        },
      },
      {
        rowNo: 2,
        normalized: {
          merchantName: '  spec gym  ',
          city: 'BANGALORE',
          title: '6 month pass',
        },
      },
    ]);
    expect(dupes).toEqual(new Set([2]));
  });

  it('does not flag genuinely distinct rows', () => {
    const dupes = findDuplicateRowIndexes([
      {
        rowNo: 1,
        normalized: {
          merchantName: 'Spec Gym',
          city: 'Bangalore',
          title: '6 Month Pass',
        },
      },
      {
        rowNo: 2,
        normalized: {
          merchantName: 'Spec Gym',
          city: 'Bangalore',
          title: '3 Month Pass',
        },
      },
    ]);
    expect(dupes.size).toBe(0);
  });
});
