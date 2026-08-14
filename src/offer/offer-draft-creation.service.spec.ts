import { OfferDraftCreationService } from './offer-draft-creation.service';
import { CategoryService } from '../common/taxonomy/category.service';

describe('OfferDraftCreationService', () => {
  let prisma: {
    business: { findUnique: jest.Mock; findMany: jest.Mock; create: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: OfferDraftCreationService;

  beforeEach(() => {
    prisma = {
      business: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'biz-1' }),
      },
      $transaction: jest.fn(),
    };
    service = new OfferDraftCreationService(prisma as any, new CategoryService());
  });

  describe('matchOrCreateBusiness', () => {
    it('reuses an existing business found by mobile, without creating a new one', async () => {
      prisma.business.findUnique.mockResolvedValue({ id: 'existing-biz' });

      const result = await service.matchOrCreateBusiness({
        merchantName: 'Spec Gym',
        mobile: '9876543210',
      });

      expect(result).toEqual({ businessId: 'existing-biz', created: false });
      expect(prisma.business.create).not.toHaveBeenCalled();
    });

    it('creates a new UNCLAIMED business when no mobile match exists', async () => {
      const result = await service.matchOrCreateBusiness({
        merchantName: 'Spec Gym',
        mobile: '9876543210',
        category: 'Fitness',
      });

      expect(result).toEqual({ businessId: 'biz-1', created: true });
      expect(prisma.business.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            business_name: 'Spec Gym',
            mobile: '9876543210',
            // Normalised on write — a caller passing the display-cased
            // 'Fitness' must never persist a second spelling of a
            // category that already exists as 'fitness'.
            category: 'fitness',
            business_status: 'UNCLAIMED',
            source: 'ADMIN',
          }),
        }),
      );
    });

    // No phone at all (Offer Publisher's Step 1 placeholder case, before a
    // merchant is known) must not attempt a lookup that would incorrectly
    // match every other phone-less business by a shared null/undefined key.
    it('skips the lookup and creates directly when no mobile is given', async () => {
      const result = await service.matchOrCreateBusiness({
        merchantName: 'Untitled Merchant',
      });

      expect(prisma.business.findUnique).not.toHaveBeenCalled();
      expect(result.created).toBe(true);
    });

    // 2026-08-13 — created_by_ai discriminates a business the AI Offer
    // Collector spun up on its own from one an admin created manually
    // (Offer Publisher's own placeholder businesses) — the flag the claim
    // flows (ClaimRequestService, AuthService.absorbUnclaimedAiBusiness)
    // and the Shop Onboardings exclusion (DashboardService) key off of.
    it('sets created_by_ai: true only when the caller explicitly passes createdByAi: true', async () => {
      await service.matchOrCreateBusiness({ merchantName: 'AI Found Gym', createdByAi: true });
      expect(prisma.business.create.mock.calls[0][0].data.created_by_ai).toBe(true);
    });

    it('defaults created_by_ai to false when the caller omits it — Offer Publisher\'s own placeholder businesses are unaffected', async () => {
      await service.matchOrCreateBusiness({ merchantName: 'Manually Added Shop' });
      expect(prisma.business.create.mock.calls[0][0].data.created_by_ai).toBe(false);
    });

    it('fills every NOT NULL Business column even when the caller supplies almost nothing', async () => {
      await service.matchOrCreateBusiness({ merchantName: 'X' });

      const data = prisma.business.create.mock.calls[0][0].data;
      expect(data.owner_name).toBe('X');
      expect(data.business_type).toBe('');
      // A placeholder business genuinely has no category yet, so an empty
      // value resolves to the `general` holding pen rather than an empty
      // string — which would otherwise become its own phantom category.
      expect(data.category).toBe('general');
      expect(data.address).toBe('');
      expect(data.city).toBe('');
      expect(data.state).toBe('');
      expect(data.pincode).toBe('');
    });

    // 2026-08-11 — added so the AI Offer Review flow (which routinely has no
    // mobile, or one the merchant never registered with Pairley before)
    // doesn't spawn a second UNCLAIMED Business for a merchant already on
    // file. Deliberately conservative: exact string match only, after
    // normalization done in JS, never a fuzzy/partial match.
    describe('name + city matching (no mobile match)', () => {
      it('reuses an existing business on an exact normalized name + city match', async () => {
        prisma.business.findMany.mockResolvedValue([
          { id: 'existing-biz', business_name: 'Shapes Gym', city: 'Bangalore' },
        ]);

        const result = await service.matchOrCreateBusiness({
          merchantName: 'Shapes Gym',
          city: 'Bangalore',
        });

        expect(result).toEqual({ businessId: 'existing-biz', created: false });
        expect(prisma.business.create).not.toHaveBeenCalled();
      });

      it('normalizes case and whitespace on both sides before comparing', async () => {
        prisma.business.findMany.mockResolvedValue([
          { id: 'existing-biz', business_name: '  shapes   gym ', city: 'BANGALORE' },
        ]);

        const result = await service.matchOrCreateBusiness({
          merchantName: 'Shapes Gym',
          city: 'Bangalore',
        });

        expect(result).toEqual({ businessId: 'existing-biz', created: false });
      });

      it('does NOT merge a same-named business in a DIFFERENT city — creates a new one instead', async () => {
        prisma.business.findMany.mockResolvedValue([
          { id: 'other-city-biz', business_name: 'Shapes Gym', city: 'Mumbai' },
        ]);

        const result = await service.matchOrCreateBusiness({
          merchantName: 'Shapes Gym',
          city: 'Bangalore',
        });

        expect(result.created).toBe(true);
        expect(result.businessId).toBe('biz-1');
      });

      it('skips the name+city lookup entirely when city is not supplied — no signal, no guess', async () => {
        const result = await service.matchOrCreateBusiness({ merchantName: 'Shapes Gym' });

        expect(prisma.business.findMany).not.toHaveBeenCalled();
        expect(result.created).toBe(true);
      });

      it('an exact mobile match still wins over name+city — mobile is checked first', async () => {
        prisma.business.findUnique.mockResolvedValue({ id: 'mobile-match' });

        const result = await service.matchOrCreateBusiness({
          merchantName: 'Shapes Gym',
          mobile: '9876543210',
          city: 'Bangalore',
        });

        expect(result).toEqual({ businessId: 'mobile-match', created: false });
        expect(prisma.business.findMany).not.toHaveBeenCalled();
      });
    });

    it('uses the given transaction client instead of the default prisma instance when provided', async () => {
      const txClient = {
        business: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'tx-biz' }),
        },
      };

      const result = await service.matchOrCreateBusiness(
        { merchantName: 'Spec Gym', mobile: '111' },
        txClient as any,
      );

      expect(result.businessId).toBe('tx-biz');
      expect(txClient.business.create).toHaveBeenCalled();
      expect(prisma.business.create).not.toHaveBeenCalled();
    });
  });

  describe('createPlaceholderDraft', () => {
    it('creates a placeholder UNCLAIMED business and a DRAFT offer with the cover image attached, atomically', async () => {
      const business = { id: 'biz-1' };
      const offer = { id: 'offer-1' };
      const tx = {
        business: { create: jest.fn().mockResolvedValue(business) },
        offer: { create: jest.fn().mockResolvedValue(offer) },
      };
      prisma.$transaction.mockImplementation((cb) => cb(tx));

      const result = await service.createPlaceholderDraft(
        'https://firebasestorage.googleapis.com/v0/b/x/o/cover.jpg',
      );

      expect(result).toEqual({ businessId: 'biz-1', offerId: 'offer-1' });
      expect(tx.business.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            business_status: 'UNCLAIMED',
            source: 'ADMIN',
          }),
        }),
      );
      expect(tx.offer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            business_id: 'biz-1',
            status: 'DRAFT',
            source: 'ADMIN',
            cover_image:
              'https://firebasestorage.googleapis.com/v0/b/x/o/cover.jpg',
            offer_type: 'STANDARD',
            required_people: 1,
          }),
        }),
      );
    });

    it('sets a 30-day validity window from now, so a placeholder draft is never immediately expired', async () => {
      const tx = {
        business: { create: jest.fn().mockResolvedValue({ id: 'biz-1' }) },
        offer: { create: jest.fn().mockResolvedValue({ id: 'offer-1' }) },
      };
      prisma.$transaction.mockImplementation((cb) => cb(tx));

      await service.createPlaceholderDraft('https://example.com/x.jpg');

      const data = tx.offer.create.mock.calls[0][0].data;
      const spanMs = data.end_date.getTime() - data.start_date.getTime();
      expect(spanMs).toBe(30 * 24 * 60 * 60 * 1000);
    });
  });
});
