import { OfferType } from '@prisma/client';
import { NormalizationService } from './normalization.service';
import { ExtractedFields } from './content-extraction.service';

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function fields(overrides: Partial<ExtractedFields> = {}): ExtractedFields {
  return {
    title: null,
    description: null,
    image: null,
    price: null,
    ...overrides,
  };
}

describe('NormalizationService', () => {
  let service: NormalizationService;

  beforeEach(() => {
    service = new NormalizationService();
  });

  describe('price/discount normalization', () => {
    it('parses an explicit "was X now Y" pattern into a real discount split', () => {
      const result = service.normalize(
        fields({
          price: 599,
          rawText: 'Diwali Sale — was ₹999 now ₹599 only!',
        }),
      );
      expect(result.original_price).toBe(999);
      expect(result.offer_price).toBe(599);
    });

    it('backs out the original price from a percentage-off signal plus the found price', () => {
      const result = service.normalize(
        fields({ price: 599, rawText: 'Flat 40% off — Rs. 599' }),
      );
      expect(result.offer_price).toBe(599);
      expect(result.original_price).toBeCloseTo(998.33, 2);
    });

    it('recognizes "percent off" phrasing, not just "%"', () => {
      const result = service.normalize(
        fields({
          price: 300,
          rawText: 'Flat 40 percent off storewide, now Rs 300',
        }),
      );
      expect(result.offer_price).toBe(300);
      expect(result.original_price).toBeCloseTo(500, 2);
    });

    it('backs out the original price from a flat-amount-off signal plus the found price', () => {
      const result = service.normalize(
        fields({ price: 799, rawText: 'Flat ₹200 off — now only ₹799' }),
      );
      expect(result.original_price).toBe(999);
      expect(result.offer_price).toBe(799);
    });

    it('treats a single found price with no discount signal as both original and offer price — unchanged Module 9/10 behavior', () => {
      const result = service.normalize(
        fields({ price: 499, rawText: 'Grand opening special, just ₹499' }),
      );
      expect(result.original_price).toBe(499);
      expect(result.offer_price).toBe(499);
    });

    it('returns null for both prices when no price was found at all', () => {
      const result = service.normalize(
        fields({ price: null, rawText: 'Come visit our store today' }),
      );
      expect(result.original_price).toBeNull();
      expect(result.offer_price).toBeNull();
    });

    it('ignores a "was...now" match where the offer price is not actually lower (nonsensical), falling back', () => {
      const result = service.normalize(
        fields({ price: 500, rawText: 'was ₹300 now ₹500' }),
      );
      expect(result.original_price).toBe(500);
      expect(result.offer_price).toBe(500);
    });

    it('ignores an out-of-range percentage (>=100% off), falling back to the plain found price', () => {
      const result = service.normalize(
        fields({ price: 299, rawText: '100% off everything!' }),
      );
      expect(result.original_price).toBe(299);
      expect(result.offer_price).toBe(299);
    });

    it('falls back to null/null when rawText is absent (e.g. an older test fixture)', () => {
      const result = service.normalize(fields({ price: null }));
      expect(result.original_price).toBeNull();
      expect(result.offer_price).toBeNull();
    });
  });

  describe('offer_type classification', () => {
    const cases: Array<[string, OfferType]> = [
      ['Buy 1 Get 1 Free on all items', OfferType.BOGO],
      ['Buy One Get Two combo deal', OfferType.BOGT],
      ['Get instant cashback on every purchase', OfferType.CASHBACK],
      ['Annual membership plan available now', OfferType.MEMBERSHIP_CAMPAIGN],
      ['Bulk order discounts for wholesale buyers', OfferType.BULK_PURCHASE],
      ['Group discount for a group of 5', OfferType.GROUP_DISCOUNT],
      ['Special package deal this week', OfferType.PACKAGE_DEAL],
      ['Flash sale today only', OfferType.FLASH_DEAL],
      ['Only 5 pieces left in stock', OfferType.LIMITED_QUANTITY],
      ['Limited time offer, ends soon', OfferType.LIMITED_TIME],
      ['Diwali special offer', OfferType.FESTIVAL],
      ['Summer collection sale', OfferType.SEASONAL],
      ['Flat ₹100 off your bill', OfferType.FLAT_DISCOUNT],
      ['25% off everything today', OfferType.PERCENTAGE_DISCOUNT],
      ['Amazing combo offer for two', OfferType.COMBO],
      ['Buy 3 Get 2 free', OfferType.BUY_X_GET_Y],
    ];

    it.each(cases)('classifies "%s" as %s', (text, expected) => {
      const result = service.normalize(fields({ rawText: text }));
      expect(result.offer_type).toBe(expected);
    });

    it('defaults to STANDARD when nothing matches — same default every candidate got before Module 11', () => {
      const result = service.normalize(
        fields({ rawText: 'Welcome to our store' }),
      );
      expect(result.offer_type).toBe(OfferType.STANDARD);
    });

    it('defaults to STANDARD when rawText is absent', () => {
      const result = service.normalize(fields());
      expect(result.offer_type).toBe(OfferType.STANDARD);
    });
  });

  describe('validity_end extraction', () => {
    it('parses an explicit day/month/year into the correct future date', () => {
      const target = new Date();
      target.setDate(target.getDate() + 60);
      const text = `Valid till ${target.getDate()} ${MONTH_NAMES[target.getMonth()]} ${target.getFullYear()}`;

      const result = service.normalize(fields({ rawText: text }));

      expect(result.validity_end).not.toBeNull();
      expect(result.validity_end?.getFullYear()).toBe(target.getFullYear());
      expect(result.validity_end?.getMonth()).toBe(target.getMonth());
      expect(result.validity_end?.getDate()).toBe(target.getDate());
    });

    it('assumes the current year when none is given, and stays correct across a year boundary', () => {
      const target = new Date();
      target.setDate(target.getDate() + 30);
      const text = `Offer ends ${target.getDate()} ${MONTH_NAMES[target.getMonth()]}`;

      const result = service.normalize(fields({ rawText: text }));

      expect(result.validity_end).not.toBeNull();
      expect(result.validity_end?.getFullYear()).toBe(target.getFullYear());
      expect(result.validity_end?.getMonth()).toBe(target.getMonth());
      expect(result.validity_end?.getDate()).toBe(target.getDate());
    });

    it('returns null when no date phrasing is present at all', () => {
      const result = service.normalize(
        fields({ rawText: 'Best offers in town, visit today' }),
      );
      expect(result.validity_end).toBeNull();
    });

    it('returns null for a clearly-invalid day/month combination', () => {
      const result = service.normalize(
        fields({ rawText: 'Valid till 99 Foo 2026' }),
      );
      expect(result.validity_end).toBeNull();
    });

    it('rejects an explicit date more than 2 years in the future as implausible', () => {
      const farFuture = new Date();
      farFuture.setFullYear(farFuture.getFullYear() + 3);
      const text = `Valid till ${farFuture.getDate()} ${MONTH_NAMES[farFuture.getMonth()]} ${farFuture.getFullYear()}`;

      const result = service.normalize(fields({ rawText: text }));
      expect(result.validity_end).toBeNull();
    });

    it('rejects an explicit date clearly in the past', () => {
      const past = new Date();
      past.setDate(past.getDate() - 30);
      const text = `Valid till ${past.getDate()} ${MONTH_NAMES[past.getMonth()]} ${past.getFullYear()}`;

      const result = service.normalize(fields({ rawText: text }));
      expect(result.validity_end).toBeNull();
    });

    it('returns null when rawText is absent', () => {
      const result = service.normalize(fields());
      expect(result.validity_end).toBeNull();
    });
  });
});
