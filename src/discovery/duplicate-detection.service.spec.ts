import { OfferStatus, OfferType, Source } from '@prisma/client';
import { DuplicateDetectionService } from './duplicate-detection.service';
import { PrismaService } from '../prisma/prisma.service';

function offer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'offer-new',
    title: 'Diwali Mega Sale',
    description: 'desc',
    offer_type: OfferType.PERCENTAGE_DISCOUNT,
    category: 'shopping',
    original_price: 999,
    offer_price: 599,
    status: OfferStatus.DRAFT,
    source: Source.WEBSITE,
    business_id: 'business-new',
    ...overrides,
  };
}

function poolOffer(
  overrides: Record<string, unknown> = {},
  businessName = 'ABC Store (imported)',
) {
  return {
    ...offer({ id: 'offer-existing', ...overrides }),
    business: { business_name: businessName },
  };
}

function business(overrides: Record<string, unknown> = {}) {
  return {
    id: 'business-new',
    business_name: 'ABC Store (imported)',
    mobile: null,
    geo_lat: null,
    geo_lng: null,
    business_status: 'UNCLAIMED',
    ...overrides,
  };
}

describe('DuplicateDetectionService', () => {
  let offerFindMany: jest.Mock;
  let offerUpdate: jest.Mock;
  let businessFindMany: jest.Mock;
  let businessUpdate: jest.Mock;
  let service: DuplicateDetectionService;

  beforeEach(() => {
    offerFindMany = jest.fn().mockResolvedValue([]);
    offerUpdate = jest.fn().mockResolvedValue({});
    businessFindMany = jest.fn().mockResolvedValue([]);
    businessUpdate = jest.fn().mockResolvedValue({});

    const prisma = {
      offer: { findMany: offerFindMany, update: offerUpdate },
      business: { findMany: businessFindMany, update: businessUpdate },
    };
    service = new DuplicateDetectionService(prisma as unknown as PrismaService);
  });

  describe('findOfferDuplicate', () => {
    it('flags an exact-title, same-price, same-type, same-merchant offer as a duplicate (website vs website)', async () => {
      offerFindMany.mockResolvedValue([poolOffer({ source: Source.WEBSITE })]);
      const result = await service.findOfferDuplicate(
        offer({ source: Source.WEBSITE }),
        'ABC Store (imported)',
      );
      expect(result).not.toBeNull();
      expect(result?.id).toBe('offer-existing');
      expect(result?.score).toBeGreaterThanOrEqual(0.55);
    });

    it('flags a duplicate across sources — website original vs poster re-import', async () => {
      offerFindMany.mockResolvedValue([poolOffer({ source: Source.WEBSITE })]);
      const result = await service.findOfferDuplicate(
        offer({ source: Source.POSTER }),
        'ABC Store (imported)',
      );
      expect(result).not.toBeNull();
    });

    it('flags a duplicate across sources — poster original vs PDF re-import', async () => {
      offerFindMany.mockResolvedValue([
        poolOffer({ source: Source.POSTER }, 'Poster Import (imported)'),
      ]);
      const result = await service.findOfferDuplicate(
        offer({ source: Source.PDF }),
        'PDF Import (imported)',
      );
      expect(result).not.toBeNull();
    });

    it('flags near-duplicate titles with partial word overlap plus corroborating signals', async () => {
      offerFindMany.mockResolvedValue([
        poolOffer({ title: 'Diwali Mega Sale - Flat 40% Off' }),
      ]);
      const result = await service.findOfferDuplicate(
        offer({ title: 'Diwali Mega Sale' }),
        'ABC Store (imported)',
      );
      expect(result).not.toBeNull();
      expect(
        result?.reasons.some((r) => r.toLowerCase().includes('title')),
      ).toBe(true);
    });

    it('does not flag when prices are very different, even with an identical title', async () => {
      offerFindMany.mockResolvedValue([
        poolOffer(
          { offer_price: 5000, offer_type: OfferType.STANDARD },
          'Totally Different Store',
        ),
      ]);
      const result = await service.findOfferDuplicate(
        offer({ offer_price: 599, offer_type: OfferType.CASHBACK }),
        'ABC Store (imported)',
      );
      expect(result).toBeNull();
    });

    it('boosts the score when the merchant matches', async () => {
      offerFindMany.mockResolvedValue([
        poolOffer({ title: 'Weekend Special' }, 'XYZ Traders (imported)'),
      ]);
      const withSameMerchant = await service.findOfferDuplicate(
        offer({ title: 'Weekend Specials' }),
        'XYZ Traders (imported)',
      );
      const withDifferentMerchant = await service.findOfferDuplicate(
        offer({ title: 'Weekend Specials' }),
        'Someone Else Entirely',
      );
      expect(withSameMerchant?.score ?? 0).toBeGreaterThan(
        withDifferentMerchant?.score ?? 0,
      );
    });

    it('does not credit merchant similarity between two generically-labeled businesses even when content genuinely differs', async () => {
      offerFindMany.mockResolvedValue([
        poolOffer(
          {
            title: 'Gym Membership Annual Plan',
            offer_type: OfferType.MEMBERSHIP_CAMPAIGN,
            offer_price: 12000,
          },
          'Poster Import (imported)',
        ),
      ]);
      const result = await service.findOfferDuplicate(
        offer({
          title: 'Summer Blowout Sale',
          offer_type: OfferType.SEASONAL,
          offer_price: 399,
        }),
        'Poster Import (imported)',
      );
      expect(result).toBeNull();
    });

    it('avoids false positives for genuinely different offers', async () => {
      offerFindMany.mockResolvedValue([
        poolOffer(
          {
            title: 'Gym Membership Annual Plan',
            offer_type: OfferType.MEMBERSHIP_CAMPAIGN,
            offer_price: 12000,
            category: 'fitness',
          },
          'FitZone Gym',
        ),
      ]);
      const result = await service.findOfferDuplicate(
        offer({
          title: 'Diwali Mega Sale',
          offer_type: OfferType.PERCENTAGE_DISCOUNT,
          offer_price: 599,
          category: 'shopping',
        }),
        'ABC Store (imported)',
      );
      expect(result).toBeNull();
    });

    it('excludes REJECTED and ARCHIVED offers from the comparison pool', async () => {
      await service.findOfferDuplicate(offer(), 'ABC Store (imported)');
      expect(offerFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { notIn: [OfferStatus.REJECTED, OfferStatus.ARCHIVED] },
          }) as unknown,
        }) as unknown,
      );
    });

    it('never compares an offer against itself', async () => {
      await service.findOfferDuplicate(offer({ id: 'offer-1' }), 'ABC Store');
      expect(offerFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { not: 'offer-1' } }) as unknown,
        }) as unknown,
      );
    });

    it('returns null when the candidate pool is empty', async () => {
      offerFindMany.mockResolvedValue([]);
      const result = await service.findOfferDuplicate(offer(), 'ABC Store');
      expect(result).toBeNull();
    });
  });

  describe('findBusinessDuplicate', () => {
    it('flags a near-identical business name', async () => {
      businessFindMany.mockResolvedValue([
        business({ id: 'business-existing', business_name: 'ABC Store' }),
      ]);
      const result = await service.findBusinessDuplicate(
        business({ business_name: 'ABC Store (imported)' }),
      );
      expect(result).not.toBeNull();
      expect(result?.id).toBe('business-existing');
    });

    it('credits a matching mobile number alongside partial name similarity', async () => {
      businessFindMany.mockResolvedValue([
        business({
          id: 'business-existing',
          business_name: 'ABC Store Pvt Ltd',
          mobile: '9876543210',
        }),
      ]);
      const result = await service.findBusinessDuplicate(
        business({ business_name: 'ABC Store', mobile: '9876543210' }),
      );
      expect(result).not.toBeNull();
      expect(result?.reasons).toContain('Same mobile number');
    });

    it('does not flag on mobile match alone with no name similarity — mobile is a corroborating signal, not sufficient alone', async () => {
      businessFindMany.mockResolvedValue([
        business({
          id: 'business-existing',
          business_name: 'Totally Different Name',
          mobile: '9876543210',
        }),
      ]);
      const result = await service.findBusinessDuplicate(
        business({ business_name: 'ABC Store', mobile: '9876543210' }),
      );
      expect(result).toBeNull();
    });

    it('does not credit name similarity between two businesses that both still carry the generic per-source-type placeholder name', async () => {
      businessFindMany.mockResolvedValue([
        business({
          id: 'business-existing',
          business_name: 'Poster Import (imported)',
        }),
      ]);
      const result = await service.findBusinessDuplicate(
        business({ business_name: 'Poster Import (imported)' }),
      );
      expect(result).toBeNull();
    });

    it('still credits name similarity once at least one side has a real, source-derived name', async () => {
      businessFindMany.mockResolvedValue([
        business({
          id: 'business-existing',
          business_name: 'ABC Store (imported)',
        }),
      ]);
      const result = await service.findBusinessDuplicate(
        business({ business_name: 'ABC Store (imported)' }),
      );
      expect(result).not.toBeNull();
    });

    it('does not flag unrelated businesses', async () => {
      businessFindMany.mockResolvedValue([
        business({
          id: 'business-existing',
          business_name: 'Completely Unrelated Shop',
        }),
      ]);
      const result = await service.findBusinessDuplicate(
        business({ business_name: 'ABC Store' }),
      );
      expect(result).toBeNull();
    });

    it('only compares against UNCLAIMED businesses', async () => {
      await service.findBusinessDuplicate(business());
      expect(businessFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            business_status: 'UNCLAIMED',
          }) as unknown,
        }) as unknown,
      );
    });
  });

  describe('detectAndFlag', () => {
    it('persists duplicate_of_offer_id/score/reasons on the offer when a match is found', async () => {
      offerFindMany.mockResolvedValue([poolOffer()]);
      businessFindMany.mockResolvedValue([]);

      await service.detectAndFlag(offer() as never, business() as never);

      expect(offerUpdate).toHaveBeenCalledWith({
        where: { id: 'offer-new' },
        data: expect.objectContaining({
          duplicate_of_offer_id: 'offer-existing',
        }) as unknown,
      });
    });

    it('does not call update at all when no match is found for either offer or business', async () => {
      offerFindMany.mockResolvedValue([]);
      businessFindMany.mockResolvedValue([]);

      await service.detectAndFlag(offer() as never, business() as never);

      expect(offerUpdate).not.toHaveBeenCalled();
      expect(businessUpdate).not.toHaveBeenCalled();
    });

    it('swallows errors and never rethrows — a bug here must not fail the import', async () => {
      offerFindMany.mockRejectedValue(new Error('db exploded'));

      await expect(
        service.detectAndFlag(offer() as never, business() as never),
      ).resolves.toBeUndefined();
    });
  });
});
