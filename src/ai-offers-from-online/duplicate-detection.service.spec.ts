import { OfferStatus } from '@prisma/client';
import { AiOfferDuplicateDetectionService } from './duplicate-detection.service';

describe('AiOfferDuplicateDetectionService', () => {
  let prisma: { offer: { findMany: jest.Mock } };
  let service: AiOfferDuplicateDetectionService;

  beforeEach(() => {
    prisma = { offer: { findMany: jest.fn().mockResolvedValue([]) } };
    service = new AiOfferDuplicateDetectionService(prisma as any);
  });

  describe('Tier 1 — offer-specific source URL', () => {
    it('is a HIGH-confidence duplicate when the same offer-specific URL was already imported', async () => {
      prisma.offer.findMany.mockResolvedValue([
        { id: 'existing-offer-1', original_import_url: 'https://shapesgym.com/offers/annual-membership-50-off' },
      ]);

      const result = await service.check({
        businessId: 'biz-1',
        offerTitle: 'Flat 50% OFF Annual Membership',
        sourceUrl: 'https://www.shapesgym.com/offers/annual-membership-50-off/',
      });

      expect(result.confidence).toBe('HIGH');
      expect(result.duplicateOfferId).toBe('existing-offer-1');
      expect(result.reasons).toContain('same_offer_specific_source_url');
    });

    it('does NOT block on a shared Instagram PROFILE URL — two different offers can both publish', async () => {
      // isLikelyOfferSpecificUrl rejects a bare profile URL, so Tier 1 never
      // even queries — only Tier 2's same-business scan runs, and an empty
      // result there means nothing else at this business matches either.
      prisma.offer.findMany.mockResolvedValue([]);

      const result = await service.check({
        businessId: 'biz-1',
        offerTitle: 'New Year Special — 20% off Personal Training',
        sourceUrl: 'https://www.instagram.com/shapesgym/',
      });

      expect(result.confidence).toBe('LOW');
      expect(result.duplicateOfferId).toBeNull();
      // Tier 1 must never have queried at all for a non-offer-specific URL.
      expect(prisma.offer.findMany).toHaveBeenCalledTimes(1);
    });

    it('does NOT block on a shared merchant homepage/listing URL', async () => {
      prisma.offer.findMany.mockResolvedValue([]);

      const result = await service.check({
        businessId: 'biz-1',
        offerTitle: '30% off All Services',
        sourceUrl: 'https://shapesgym.com/offers',
      });

      expect(result.confidence).toBe('LOW');
    });
  });

  describe('Tier 2 — same business + same mechanic/value + title similarity', () => {
    it('HIGH: same business + same 50% offer, near-identical title', async () => {
      prisma.offer.findMany.mockResolvedValue([
        {
          id: 'existing-offer-1',
          title: 'Shapes Gym — Flat 50% OFF Annual Membership',
          description: null,
          terms: null,
          original_price: null,
          offer_price: null,
        },
      ]);

      const result = await service.check({
        businessId: 'biz-1',
        offerTitle: 'Shapes Gym — Flat 50% OFF Annual Membership',
      });

      expect(result.confidence).toBe('HIGH');
      expect(result.duplicateOfferId).toBe('existing-offer-1');
    });

    it('publishes: same business, different commercial offer (Student ₹1,299/month vs the 50%-off membership)', async () => {
      prisma.offer.findMany.mockResolvedValue([
        {
          id: 'existing-offer-1',
          title: 'Shapes Gym — Flat 50% OFF Annual Membership',
          description: null,
          terms: null,
          original_price: null,
          offer_price: null,
        },
      ]);

      const result = await service.check({
        businessId: 'biz-1',
        offerTitle: 'Shapes Gym — Student ₹1,299/month',
      });

      expect(result.confidence).toBe('LOW');
      expect(result.duplicateOfferId).toBeNull();
    });

    it('MEDIUM: same mechanic/value but title similarity only moderate — publishes with an advisory flag, never blocks', async () => {
      prisma.offer.findMany.mockResolvedValue([
        {
          id: 'existing-offer-1',
          title: 'Shapes Gym Annual Plan',
          description: null,
          terms: null,
          original_price: 999,
          offer_price: 499,
        },
      ]);

      const result = await service.check({
        businessId: 'biz-1',
        offerTitle: 'Shapes Gym Diwali Special Pass',
        originalPrice: 999,
        offerPrice: 505, // within 2% of 499
      });

      expect(result.confidence).toBe('MEDIUM');
      expect(result.duplicateOfferId).toBe('existing-offer-1');
    });

    it('never blocks OTHER-vs-OTHER (no recognizable mechanic on either side), even at the same business', async () => {
      prisma.offer.findMany.mockResolvedValue([
        {
          id: 'existing-offer-1',
          title: 'Shapes Gym Personal Training Sessions',
          description: null,
          terms: null,
          original_price: null,
          offer_price: null,
        },
      ]);

      const result = await service.check({
        businessId: 'biz-1',
        offerTitle: 'Shapes Gym Personal Training Sessions', // identical title, but neither side has a recognizable mechanic
      });

      // Title is identical (Jaccard 1.0) with no mechanic match on either
      // side -> the "strong title similarity without mechanic" MEDIUM rule
      // fires, never HIGH, since OTHER-vs-OTHER can never satisfy a
      // mechanic match.
      expect(result.confidence).not.toBe('HIGH');
    });

    it('LOW: unrelated offers at the same business', async () => {
      prisma.offer.findMany.mockResolvedValue([
        {
          id: 'existing-offer-1',
          title: 'Shapes Gym Personal Training Sessions',
          description: null,
          terms: null,
          original_price: null,
          offer_price: null,
        },
      ]);

      const result = await service.check({
        businessId: 'biz-1',
        offerTitle: 'Shapes Gym Zumba Classes',
      });

      expect(result.confidence).toBe('LOW');
      expect(result.duplicateOfferId).toBeNull();
    });

    it('only compares offers within the resolved business — a different business is never flagged', async () => {
      prisma.offer.findMany.mockImplementation(({ where }: any) => {
        // Tier 2 always filters by business_id — an empty result here means
        // the query correctly scoped to this business only.
        expect(where.business_id).toBe('biz-new');
        return Promise.resolve([]);
      });

      const result = await service.check({
        businessId: 'biz-new',
        offerTitle: 'Flat 30% OFF',
      });

      expect(result.confidence).toBe('LOW');
    });
  });

  describe('LIVE_STATUSES scoping', () => {
    it('Tier 2 only queries ACTIVE/DRAFT offers', async () => {
      prisma.offer.findMany.mockResolvedValue([]);

      await service.check({ businessId: 'biz-1', offerTitle: 'Anything' });

      const tier2Call = prisma.offer.findMany.mock.calls.find((c) => c[0].where?.business_id);
      expect(tier2Call[0].where.status).toEqual({ in: [OfferStatus.ACTIVE, OfferStatus.DRAFT] });
    });
  });
});
