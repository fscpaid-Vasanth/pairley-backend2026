import { AiOfferFromOnlineStatus, OfferStatus } from '@prisma/client';
import { AiOffersFromOnlineService } from './ai-offers-from-online.service';
import { CategoryService } from '../common/taxonomy/category.service';
import { DuplicateCheckResult } from './duplicate-detection.service';

const LOW: DuplicateCheckResult = { confidence: 'LOW', duplicateOfferId: null, score: null, reasons: [] };

function makeOffer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aio-1',
    collector_offer_id: 'collector-offer-1',
    status: AiOfferFromOnlineStatus.PENDING_ADMIN_REVIEW,
    matched_business_id: null,
    created_business_id: null,
    created_offer_id: null,
    merchant_name: 'Spec Gym',
    mobile: '9876543210',
    whatsapp: null,
    category: 'gym',
    address: 'Bangalore',
    city: 'Bangalore',
    offer_title: 'Flat 40% Off',
    description: 'Annual membership deal',
    original_price: 10000,
    offer_price: 6000,
    validity_start: null,
    validity_end: null,
    terms: null,
    banner_image_url: 'https://storage.example/banner.png',
    source_url: null,
    source_type: null,
    field_provenance: {},
    rejection_reason: null,
    failure_reason: null,
    exported_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

const VALID_EXPORT = {
  collectorOfferId: 'collector-offer-1',
  merchantName: 'Spec Gym',
  offerTitle: 'Flat 40% Off',
  address: 'Bangalore',
  offerPrice: 6000,
};

const BANNER_FILE = { originalname: 'banner.png', buffer: Buffer.from('x'), mimetype: 'image/png' } as Express.Multer.File;

describe('AiOffersFromOnlineService', () => {
  let prisma: any;
  let storage: { uploadFile: jest.Mock };
  let draftCreation: { matchOrCreateBusiness: jest.Mock };
  let offerPublisherService: { approveDraft: jest.Mock; publishDraft: jest.Mock; searchBusinesses: jest.Mock };
  let duplicateDetection: { check: jest.Mock };
  let service: AiOffersFromOnlineService;

  beforeEach(() => {
    prisma = {
      aiOfferFromOnline: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
      },
      business: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      offer: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ status: OfferStatus.DRAFT }),
      },
    };
    storage = { uploadFile: jest.fn().mockResolvedValue('https://storage.example/banner.png') };
    draftCreation = { matchOrCreateBusiness: jest.fn().mockResolvedValue({ businessId: 'new-biz-1', created: true }) };
    offerPublisherService = {
      approveDraft: jest.fn().mockResolvedValue({}),
      publishDraft: jest.fn().mockResolvedValue({}),
      searchBusinesses: jest.fn().mockResolvedValue([]),
    };
    duplicateDetection = { check: jest.fn().mockResolvedValue(LOW) };

    service = new AiOffersFromOnlineService(
      prisma,
      storage as any,
      draftCreation as any,
      offerPublisherService as any,
      new CategoryService(),
      duplicateDetection as any,
    );
  });

  // 2026-08-12 — the admin grid's claim-status column. matched_business_id/
  // created_business_id are plain scalar strings (no formal relation), so
  // list() does its own batched second query + in-memory join.
  describe('list — claim status', () => {
    it('attaches the linked business\'s business_status as claim_status', async () => {
      prisma.aiOfferFromOnline.findMany.mockResolvedValue([
        makeOffer({ id: 'aio-1', matched_business_id: 'biz-1' }),
        makeOffer({ id: 'aio-2', created_business_id: 'biz-2' }),
      ]);
      prisma.business.findMany.mockResolvedValue([
        { id: 'biz-1', business_status: 'CLAIMED' },
        { id: 'biz-2', business_status: 'UNCLAIMED' },
      ]);

      const result = await service.list();

      expect(prisma.business.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['biz-1', 'biz-2'] } },
        select: { id: true, business_status: true },
      });
      expect(result.find((o: any) => o.id === 'aio-1').claim_status).toBe('CLAIMED');
      expect(result.find((o: any) => o.id === 'aio-2').claim_status).toBe('UNCLAIMED');
    });

    it('claim_status is null for an offer with no business matched/created yet, without querying business.findMany at all', async () => {
      prisma.aiOfferFromOnline.findMany.mockResolvedValue([
        makeOffer({ id: 'aio-1', matched_business_id: null, created_business_id: null }),
      ]);

      const result = await service.list();

      expect(prisma.business.findMany).not.toHaveBeenCalled();
      expect(result[0].claim_status).toBeNull();
    });
  });

  describe('importExportedOffer — the "Export to Pairley" intake', () => {
    it('imports a complete export and lands it in PENDING_ADMIN_REVIEW, creating no Business or Offer', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(null);
      prisma.aiOfferFromOnline.upsert.mockResolvedValue({ id: 'aio-1', status: AiOfferFromOnlineStatus.PENDING_ADMIN_REVIEW });

      const result = await service.importExportedOffer(VALID_EXPORT, BANNER_FILE);

      expect(result).toEqual({ id: 'aio-1', status: AiOfferFromOnlineStatus.PENDING_ADMIN_REVIEW });
      expect(prisma.aiOfferFromOnline.upsert).toHaveBeenCalledTimes(1);
      // Export must NEVER create a merchant or an offer — staging only.
      expect(prisma.offer.create).not.toHaveBeenCalled();
      expect(draftCreation.matchOrCreateBusiness).not.toHaveBeenCalled();
    });

    it('stores the exact approved banner bytes it was given — never regenerates or replaces the image', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(null);
      prisma.aiOfferFromOnline.upsert.mockImplementation(({ create }: any) => Promise.resolve({ id: 'aio-1', ...create }));

      await service.importExportedOffer(VALID_EXPORT, BANNER_FILE);

      expect(storage.uploadFile).toHaveBeenCalledWith(BANNER_FILE, expect.stringContaining('ai-offers-from-online'));
      expect(prisma.aiOfferFromOnline.upsert.mock.calls[0][0].create.banner_image_url).toBe('https://storage.example/banner.png');
    });

    it('a normal price offer is accepted with its real offerPrice stored', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(null);
      prisma.aiOfferFromOnline.upsert.mockImplementation(({ create }: any) => Promise.resolve({ id: 'aio-1', ...create }));

      await service.importExportedOffer(VALID_EXPORT, BANNER_FILE);

      expect(prisma.aiOfferFromOnline.upsert.mock.calls[0][0].create.offer_price).toBe(6000);
    });

    it('stores the raw sourcePrice/sourceCurrency separately from offer_price — audit only, never overwritten', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(null);
      prisma.aiOfferFromOnline.upsert.mockImplementation(({ create }: any) => Promise.resolve({ id: 'aio-1', ...create }));

      await service.importExportedOffer({ ...VALID_EXPORT, sourcePrice: 5999, sourceCurrency: 'INR' }, BANNER_FILE);

      const create = prisma.aiOfferFromOnline.upsert.mock.calls[0][0].create;
      expect(create.source_price).toBe(5999);
      expect(create.source_currency).toBe('INR');
      expect(create.offer_price).toBe(6000); // unaffected — offer_price is the separately-verified field
    });

    it('defaults source_currency to INR when the Collector omits it', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(null);
      prisma.aiOfferFromOnline.upsert.mockImplementation(({ create }: any) => Promise.resolve({ id: 'aio-1', ...create }));

      await service.importExportedOffer(VALID_EXPORT, BANNER_FILE);

      expect(prisma.aiOfferFromOnline.upsert.mock.calls[0][0].create.source_currency).toBe('INR');
    });

    // offerPrice is nullable (2026-08-11): the Collector's own readiness gate
    // already decided these offers may export with no numeric price, because
    // each carries a verified non-price promotional mechanic instead. Pairley
    // has no visibility into WHICH mechanic applied — from this endpoint's
    // perspective every one of these is identical (offerPrice omitted,
    // accepted, stored null) — but each is written out explicitly so the
    // contract this endpoint honors is traceable case by case, not just
    // asserted once in the abstract.
    it.each([
      ['a stated-percentage-only offer (no original price, no numeric offer price)', { offerTitle: 'Flat 30% Off All Services' }],
      ['a BOGO offer', { offerTitle: 'Buy One Get One Free on all pastries' }],
      ['a BOGT offer', { offerTitle: 'Buy 2 Pairs, Get Your 3rd Free' }],
      ['an explicit free-benefit offer', { offerTitle: 'Sign up today and get one month free' }],
    ])('accepts %s exported with offerPrice omitted, storing offer_price as null — never 0, never guessed', async (_label, overrides) => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(null);
      prisma.aiOfferFromOnline.upsert.mockImplementation(({ create }: any) => Promise.resolve({ id: 'aio-1', ...create }));

      const result = await service.importExportedOffer({ ...VALID_EXPORT, ...overrides, offerPrice: undefined }, BANNER_FILE);

      expect(result.status).toBe(AiOfferFromOnlineStatus.PENDING_ADMIN_REVIEW);
      expect(prisma.aiOfferFromOnline.upsert.mock.calls[0][0].create.offer_price).toBeNull();
      expect(prisma.aiOfferFromOnline.upsert.mock.calls[0][0].create.offer_price).not.toBe(0);
    });

    it('REFUSES an export whose offerPrice is present but not a positive number — malformed input, not a legitimate non-price offer', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(null);

      await expect(service.importExportedOffer({ ...VALID_EXPORT, offerPrice: 0 }, BANNER_FILE)).rejects.toThrow(/must be a positive number/);
      await expect(service.importExportedOffer({ ...VALID_EXPORT, offerPrice: -50 }, BANNER_FILE)).rejects.toThrow(/must be a positive number/);
      await expect(service.importExportedOffer({ ...VALID_EXPORT, offerPrice: NaN }, BANNER_FILE)).rejects.toThrow(/must be a positive number/);
      expect(prisma.aiOfferFromOnline.upsert).not.toHaveBeenCalled();
    });

    it('preserves originalPrice when supplied alongside a non-price qualifying offer (e.g. a percentage calculated off a real original price elsewhere, or just informational)', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(null);
      prisma.aiOfferFromOnline.upsert.mockImplementation(({ create }: any) => Promise.resolve({ id: 'aio-1', ...create }));

      await service.importExportedOffer({ ...VALID_EXPORT, offerPrice: undefined, originalPrice: 1000 }, BANNER_FILE);

      expect(prisma.aiOfferFromOnline.upsert.mock.calls[0][0].create.original_price).toBe(1000);
      expect(prisma.aiOfferFromOnline.upsert.mock.calls[0][0].create.offer_price).toBeNull();
    });

    it('REFUSES a first export with no banner — Pairley never receives a banner-less offer to complete itself', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(null);

      await expect(service.importExportedOffer(VALID_EXPORT, undefined)).rejects.toThrow(/banner is required/);
      expect(prisma.aiOfferFromOnline.upsert).not.toHaveBeenCalled();
    });

    it('a re-export may omit the banner and keeps the one already stored', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer());
      prisma.aiOfferFromOnline.upsert.mockImplementation(({ update }: any) => Promise.resolve({ id: 'aio-1', ...update }));

      await service.importExportedOffer(VALID_EXPORT, undefined);

      expect(storage.uploadFile).not.toHaveBeenCalled();
      expect(prisma.aiOfferFromOnline.upsert.mock.calls[0][0].update.banner_image_url).toBe('https://storage.example/banner.png');
    });

    it('re-exporting the same collector offer upserts atomically on collector_offer_id — never a duplicate row, never an unhandled unique-constraint crash', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer());
      prisma.aiOfferFromOnline.upsert.mockResolvedValue({ id: 'aio-1', status: AiOfferFromOnlineStatus.PENDING_ADMIN_REVIEW });

      await service.importExportedOffer(VALID_EXPORT, BANNER_FILE);

      expect(prisma.aiOfferFromOnline.create).not.toHaveBeenCalled();
      expect(prisma.aiOfferFromOnline.update).not.toHaveBeenCalled();
      expect(prisma.aiOfferFromOnline.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.aiOfferFromOnline.upsert.mock.calls[0][0].where).toEqual({ collector_offer_id: 'collector-offer-1' });
    });

    it('never silently reopens a PUBLISHED or REJECTED offer on re-export', async () => {
      for (const terminal of [AiOfferFromOnlineStatus.PUBLISHED, AiOfferFromOnlineStatus.REJECTED]) {
        prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ status: terminal }));
        prisma.aiOfferFromOnline.upsert.mockImplementation(({ update }: any) => Promise.resolve({ id: 'aio-1', ...update }));

        const result = await service.importExportedOffer(VALID_EXPORT, BANNER_FILE);

        expect(result.status).toBe(terminal);
      }
    });
  });

  describe('merchant matching — never automatic', () => {
    it('matchBusiness sets matched_business_id and MERCHANT_MATCHED, creating no new business', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer());
      prisma.business.findUnique.mockResolvedValue({ id: 'biz-1' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.matchBusiness('aio-1', 'biz-1');

      expect(result.matched_business_id).toBe('biz-1');
      expect(result.status).toBe(AiOfferFromOnlineStatus.MERCHANT_MATCHED);
      expect(draftCreation.matchOrCreateBusiness).not.toHaveBeenCalled();
    });

    it('createMerchant is the ONLY path that creates a business, and only on an explicit admin call', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer());
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.createMerchant('aio-1');

      expect(draftCreation.matchOrCreateBusiness).toHaveBeenCalledTimes(1);
      expect(draftCreation.matchOrCreateBusiness).toHaveBeenCalledWith(expect.objectContaining({ createdByAi: true }));
      expect(result.created_business_id).toBe('new-biz-1');
      expect(result.status).toBe(AiOfferFromOnlineStatus.MERCHANT_MATCHED);
    });
  });

  describe('publish', () => {
    it('auto-resolves a business via matchOrCreateBusiness when no admin match/create happened first — merchant onboarding is never a prerequisite', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: null, created_business_id: null }));
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-1' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publish('aio-1');

      expect(draftCreation.matchOrCreateBusiness).toHaveBeenCalledTimes(1);
      // Only ai-offers-from-online creates a business BECAUSE the AI
      // Collector found it — createdByAi:true is what the claim flows
      // (ClaimRequestService, AuthService.absorbUnclaimedAiBusiness) key
      // off of, and what excludes it from Shop Onboardings.
      expect(draftCreation.matchOrCreateBusiness).toHaveBeenCalledWith(expect.objectContaining({ createdByAi: true }));
      expect(prisma.offer.create.mock.calls[0][0].data.business_id).toBe('new-biz-1');
      expect(result.status).toBe(AiOfferFromOnlineStatus.PUBLISHED);
    });

    it('creates the real Offer, delegates approve+publish to Offer Publisher, and lands PUBLISHED', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: 'biz-1' }));
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-1' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publish('aio-1');

      expect(prisma.offer.create).toHaveBeenCalledTimes(1);
      // The approved banner becomes the offer's cover image — not a new render.
      expect(prisma.offer.create.mock.calls[0][0].data.cover_image).toBe('https://storage.example/banner.png');
      expect(prisma.offer.create.mock.calls[0][0].data.status).toBe(OfferStatus.DRAFT);
      // allowMissingPrice: true — this pipeline's offer_price may be the 0
      // sentinel, and approveDraft() must not reject it for that.
      expect(offerPublisherService.approveDraft).toHaveBeenCalledWith('real-offer-1', true);
      expect(offerPublisherService.publishDraft).toHaveBeenCalledWith('real-offer-1');
      expect(result.status).toBe(AiOfferFromOnlineStatus.PUBLISHED);
    });

    it('reuses an already-created Offer instead of creating a duplicate (publish idempotency)', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: 'biz-1', created_offer_id: 'real-offer-1' }));
      prisma.offer.findUnique.mockResolvedValue({ id: 'real-offer-1' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      await service.publish('aio-1');

      expect(prisma.offer.create).not.toHaveBeenCalled();
      expect(offerPublisherService.publishDraft).toHaveBeenCalledWith('real-offer-1');
    });

    it('resumes rather than replays: an Offer already APPROVED by a failed prior attempt skips approveDraft', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: 'biz-1', created_offer_id: 'real-offer-1' }));
      prisma.offer.findUnique.mockResolvedValue({ id: 'real-offer-1' });
      prisma.offer.findUniqueOrThrow.mockResolvedValue({ status: OfferStatus.APPROVED });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      await service.publish('aio-1');

      expect(offerPublisherService.approveDraft).not.toHaveBeenCalled();
      expect(offerPublisherService.publishDraft).toHaveBeenCalledWith('real-offer-1');
    });

    it('an Offer already ACTIVE is recorded as PUBLISHED without calling publishDraft again', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: 'biz-1', created_offer_id: 'real-offer-1' }));
      prisma.offer.findUnique.mockResolvedValue({ id: 'real-offer-1' });
      prisma.offer.findUniqueOrThrow.mockResolvedValue({ status: OfferStatus.ACTIVE });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publish('aio-1');

      expect(offerPublisherService.approveDraft).not.toHaveBeenCalled();
      expect(offerPublisherService.publishDraft).not.toHaveBeenCalled();
      expect(result.status).toBe(AiOfferFromOnlineStatus.PUBLISHED);
    });

    it('refuses to publish an already-PUBLISHED offer', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ status: AiOfferFromOnlineStatus.PUBLISHED, matched_business_id: 'biz-1' }));
      await expect(service.publish('aio-1')).rejects.toThrow(/already published/);
    });

    describe('duplicate detection gate', () => {
      it('HIGH confidence: blocks — no Offer created, queue row marked DUPLICATE_SUPPRESSED with the finding recorded for audit', async () => {
        prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: 'biz-1' }));
        duplicateDetection.check.mockResolvedValue({
          confidence: 'HIGH',
          duplicateOfferId: 'existing-offer-9',
          score: 0.95,
          reasons: ['same_business', 'same_mechanic:PERCENTAGE_OFF', 'title_similarity:1.00'],
        });
        prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

        const result = await service.publish('aio-1');

        expect(prisma.offer.create).not.toHaveBeenCalled();
        expect(offerPublisherService.approveDraft).not.toHaveBeenCalled();
        expect(result.status).toBe(AiOfferFromOnlineStatus.DUPLICATE_SUPPRESSED);
        expect(result.duplicate_of_offer_id).toBe('existing-offer-9');
        expect(result.duplicate_score).toBe(0.95);
        expect(result.duplicate_reasons).toContain('same_mechanic:PERCENTAGE_OFF');
      });

      it('MEDIUM confidence: publishes normally, and records the advisory relationship on the new Offer\'s own duplicate_* fields', async () => {
        prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: 'biz-1' }));
        duplicateDetection.check.mockResolvedValue({
          confidence: 'MEDIUM',
          duplicateOfferId: 'existing-offer-5',
          score: 0.55,
          reasons: ['same_business', 'title_similarity:0.30'],
        });
        prisma.offer.create.mockResolvedValue({ id: 'real-offer-1' });
        prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

        const result = await service.publish('aio-1');

        expect(prisma.offer.create).toHaveBeenCalledTimes(1);
        expect(prisma.offer.create.mock.calls[0][0].data.duplicate_of_offer_id).toBe('existing-offer-5');
        expect(prisma.offer.create.mock.calls[0][0].data.duplicate_score).toBe(0.55);
        expect(offerPublisherService.approveDraft).toHaveBeenCalledWith('real-offer-1', true);
        expect(result.status).toBe(AiOfferFromOnlineStatus.PUBLISHED);
      });

      it('LOW confidence: publishes cleanly with no duplicate fields written', async () => {
        prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: 'biz-1' }));
        duplicateDetection.check.mockResolvedValue({ confidence: 'LOW', duplicateOfferId: null, score: null, reasons: [] });
        prisma.offer.create.mockResolvedValue({ id: 'real-offer-1' });
        prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

        await service.publish('aio-1');

        expect(prisma.offer.create.mock.calls[0][0].data.duplicate_of_offer_id).toBeUndefined();
        expect(prisma.offer.create.mock.calls[0][0].data.duplicate_score).toBeUndefined();
      });

      it('does not re-run the duplicate check when resuming an already-created Offer (idempotency)', async () => {
        prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: 'biz-1', created_offer_id: 'real-offer-1' }));
        prisma.offer.findUnique.mockResolvedValue({ id: 'real-offer-1' });
        prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

        await service.publish('aio-1');

        expect(duplicateDetection.check).not.toHaveBeenCalled();
      });
    });
  });

  describe('category normalization — 2026-08-12 production fix', () => {
    it.each([
      ['Restaurants/Buffets', 'dining'],
      ['Spa/Salon', 'beauty'],
    ])('publishes an offer whose source category is "%s" by normalizing it to "%s"', async (raw, expected) => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: 'biz-1', category: raw }));
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-1' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publish('aio-1');

      expect(prisma.offer.create.mock.calls[0][0].data.category).toBe(expected);
      expect(result.status).toBe(AiOfferFromOnlineStatus.PUBLISHED);
    });

    it('a genuinely unrecognized category lands CATEGORY_REQUIRED (not FAILED), with a clearer message than the raw taxonomy error', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: 'biz-1', category: 'quantum-widgets' }));
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publish('aio-1');

      expect(result.status).toBe(AiOfferFromOnlineStatus.CATEGORY_REQUIRED);
      expect(result.failure_reason).toMatch(/Category normalization required.*quantum-widgets/);
      expect(prisma.offer.create).not.toHaveBeenCalled();
      expect(draftCreation.matchOrCreateBusiness).not.toHaveBeenCalled();
    });

    it('retrying after a CATEGORY_REQUIRED classification creates exactly one Offer — no orphan to duplicate', async () => {
      const offer = makeOffer({ matched_business_id: 'biz-1', category: 'quantum-widgets', created_offer_id: null });
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(offer);
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const first = await service.publish('aio-1');
      expect(first.status).toBe(AiOfferFromOnlineStatus.CATEGORY_REQUIRED);
      expect(prisma.offer.create).not.toHaveBeenCalled();

      // Admin corrects the category (PATCH — see correct()'s own tests for
      // the actual status transition) and retries.
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue({ ...offer, category: 'fitness', status: AiOfferFromOnlineStatus.PENDING_ADMIN_REVIEW });
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-1' });

      const result = await service.publish('aio-1');

      expect(prisma.offer.create).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(AiOfferFromOnlineStatus.PUBLISHED);
    });

    it('a null/empty category still publishes as "general", never treated as a failure', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: 'biz-1', category: null }));
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-1' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publish('aio-1');

      expect(prisma.offer.create.mock.calls[0][0].data.category).toBe('general');
      expect(result.status).toBe(AiOfferFromOnlineStatus.PUBLISHED);
    });
  });

  // 2026-08-14 — price is no longer a publish gate. Pairley's business model
  // doesn't require a numeric price (BOGO/percentage/couple/group offers are
  // all valid without one) — a null offer_price becomes a 0 sentinel on the
  // real, live Offer (never a fabricated ₹ figure), and the offer publishes
  // normally. The "never invent a price" rule stays enforced upstream, at
  // importExportedOffer() (see its own tests) — this describe block covers
  // the downstream consequence: a null price must never block or fail a
  // publish.
  describe('price is optional — a numeric price never gates publish()', () => {
    it('BOGO/BOGT/BTGT-style titles with a verified price publish normally, preserving the real price', async () => {
      for (const title of ['Buffet ₹999 + Buy 1 Get 1', 'Couple package ₹2,999', 'Buy 2 Get 3rd Free — ₹1,499 for the set']) {
        prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: 'biz-1', offer_title: title, offer_price: 999 }));
        prisma.offer.create.mockResolvedValue({ id: 'real-offer-1' });
        prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

        const result = await service.publish('aio-1');

        expect(result.status).toBe(AiOfferFromOnlineStatus.PUBLISHED);
        expect(prisma.offer.create.mock.calls[0][0].data.offer_price).toBe(999);
      }
    });

    it('a plain offer with no price at all publishes, with the real Offer created using the 0 sentinel — never blocked, never invented', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(
        makeOffer({ matched_business_id: 'biz-1', offer_title: 'Special discount this week', offer_price: null }),
      );
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-1' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publish('aio-1');

      expect(result.status).toBe(AiOfferFromOnlineStatus.PUBLISHED);
      expect(prisma.offer.create.mock.calls[0][0].data.offer_price).toBe(0);
      expect(prisma.offer.create.mock.calls[0][0].data.offer_price).not.toBeNull();
    });

    it('a BOGO offer with no numeric price publishes — offer type is never the reason for refusal', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(
        makeOffer({ matched_business_id: 'biz-1', offer_title: 'Buy One Get One Free', offer_price: null }),
      );
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-1' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publish('aio-1');

      expect(result.status).toBe(AiOfferFromOnlineStatus.PUBLISHED);
    });

    it('a percentage-off offer with no numeric price publishes', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(
        makeOffer({ matched_business_id: 'biz-1', offer_title: 'Up to 50% Off All Services', offer_price: null }),
      );
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-1' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publish('aio-1');

      expect(result.status).toBe(AiOfferFromOnlineStatus.PUBLISHED);
    });

    it('publishSelected never fails a batch on a missing price — a mixed price/no-price selection all succeed', async () => {
      prisma.aiOfferFromOnline.findUnique.mockImplementation(({ where }: any) => {
        const byId: Record<string, unknown> = {
          'priced-1': makeOffer({ id: 'priced-1', matched_business_id: 'biz-1', offer_price: 999 }),
          'priceless-1': makeOffer({ id: 'priceless-1', matched_business_id: 'biz-1', offer_price: null }),
        };
        return Promise.resolve(byId[where.id]);
      });
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-x' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publishSelected(['priced-1', 'priceless-1']);

      expect(result.published).toBe(2);
      expect(result.failed).toBe(0);
    });

    // A row already sitting in PRICE_REQUIRED from before this change (or a
    // race before the one-off reclassify script runs) must still publish
    // cleanly once publish() runs on it again — classifyForPublish() no
    // longer looks at price at all, so it just proceeds.
    it('a legacy PRICE_REQUIRED row publishes cleanly the next time publish() runs on it', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(
        makeOffer({ matched_business_id: 'biz-1', status: AiOfferFromOnlineStatus.PRICE_REQUIRED, offer_price: null }),
      );
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-1' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publish('aio-1');

      expect(result.status).toBe(AiOfferFromOnlineStatus.PUBLISHED);
      expect(prisma.offer.create.mock.calls[0][0].data.offer_price).toBe(0);
    });
  });

  describe('EXPIRED — a proxy on this offer\'s own validity_end, never a source-liveness check', () => {
    it('an offer whose validity_end has already passed lands EXPIRED, before any business/offer mutation', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(
        makeOffer({ matched_business_id: 'biz-1', validity_end: yesterday }),
      );
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publish('aio-1');

      expect(result.status).toBe(AiOfferFromOnlineStatus.EXPIRED);
      expect(result.failure_reason).toMatch(/EXPIRED/);
      expect(prisma.offer.create).not.toHaveBeenCalled();
      expect(draftCreation.matchOrCreateBusiness).not.toHaveBeenCalled();
    });

    it('a validity_end in the future is not expired — publishes normally', async () => {
      const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(
        makeOffer({ matched_business_id: 'biz-1', validity_end: nextMonth }),
      );
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-1' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publish('aio-1');

      expect(result.status).toBe(AiOfferFromOnlineStatus.PUBLISHED);
    });

    it('a null validity_end is never treated as expired', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: 'biz-1', validity_end: null }));
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-1' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publish('aio-1');

      expect(result.status).toBe(AiOfferFromOnlineStatus.PUBLISHED);
    });
  });

  describe('correct() recovers a review-state offer back into the normal flow', () => {
    it('supplying offerPrice on a PRICE_REQUIRED offer returns it to PENDING_ADMIN_REVIEW and clears the old reason', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(
        makeOffer({ status: AiOfferFromOnlineStatus.PRICE_REQUIRED, offer_price: null, failure_reason: 'PRICE REQUIRED: ...' }),
      );
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.correct('aio-1', { offerPrice: 555 });

      expect(result.status).toBe(AiOfferFromOnlineStatus.PENDING_ADMIN_REVIEW);
      expect(result.failure_reason).toBeNull();
      expect(result.offer_price).toBe(555);
    });

    it('supplying category on a CATEGORY_REQUIRED offer returns it to PENDING_ADMIN_REVIEW', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(
        makeOffer({ status: AiOfferFromOnlineStatus.CATEGORY_REQUIRED, category: 'quantum-widgets' }),
      );
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.correct('aio-1', { category: 'fitness' });

      expect(result.status).toBe(AiOfferFromOnlineStatus.PENDING_ADMIN_REVIEW);
    });

    it('editing an unrelated field on a PRICE_REQUIRED offer leaves the status untouched', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(
        makeOffer({ status: AiOfferFromOnlineStatus.PRICE_REQUIRED, offer_price: null }),
      );
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.correct('aio-1', { offerTitle: 'New Title' });

      expect(result.status).toBe(AiOfferFromOnlineStatus.PRICE_REQUIRED);
    });
  });

  describe('validateSelected — dry run, no side effects', () => {
    it('classifies category-required, expired, ready, and already-terminal offers correctly, and touches no write path', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      prisma.aiOfferFromOnline.findUnique.mockImplementation(({ where }: any) => {
        const byId: Record<string, unknown> = {
          'ready-1': makeOffer({ id: 'ready-1', category: 'fitness', offer_price: 500 }),
          'cat-1': makeOffer({ id: 'cat-1', category: 'quantum-widgets', offer_price: 500 }),
          'expired-1': makeOffer({ id: 'expired-1', validity_end: yesterday }),
          'done-1': makeOffer({ id: 'done-1', status: AiOfferFromOnlineStatus.PUBLISHED }),
        };
        return Promise.resolve(byId[where.id]);
      });

      const result = await service.validateSelected(['ready-1', 'cat-1', 'expired-1', 'done-1']);

      expect(result.total).toBe(4);
      expect(result.readyToPublish).toBe(1);
      expect(result.categoryRequired).toBe(1);
      expect(result.expired).toBe(1);
      expect(result.otherFailures).toBe(1);
      expect(result.items.find((i) => i.id === 'ready-1')!.outcome).toBe('READY');
      expect(result.items.find((i) => i.id === 'cat-1')!.outcome).toBe('CATEGORY_REQUIRED');
      expect(result.items.find((i) => i.id === 'expired-1')!.outcome).toBe('EXPIRED');
      expect(result.items.find((i) => i.id === 'done-1')!.outcome).toBe('OTHER_FAILURE');
      // A true dry run: no Business/Offer created, no queue row mutated.
      expect(prisma.offer.create).not.toHaveBeenCalled();
      expect(draftCreation.matchOrCreateBusiness).not.toHaveBeenCalled();
      expect(prisma.aiOfferFromOnline.update).not.toHaveBeenCalled();
    });

    it('a price-less offer classifies READY, not as any kind of blocked outcome', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(
        makeOffer({ id: 'aio-1', category: 'fitness', offer_price: null }),
      );

      const result = await service.validateSelected(['aio-1']);

      expect(result.readyToPublish).toBe(1);
      expect(result.items[0].outcome).toBe('READY');
    });

    it('flags a Collector-style slash category as READY with an informational normalization note, not as a failure', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(
        makeOffer({ id: 'aio-1', category: 'Restaurants/Buffets', offer_price: 500 }),
      );

      const result = await service.validateSelected(['aio-1']);

      expect(result.readyToPublish).toBe(1);
      expect(result.items[0].outcome).toBe('READY');
      expect(result.items[0].categoryNote).toBe('Category normalization required: Restaurants/Buffets → dining');
    });

    it('agrees with what publish() itself actually does — an offer broken on category alone reaches the same outcome both ways', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(
        makeOffer({ id: 'aio-1', category: 'quantum-widgets', offer_price: null }),
      );
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const dryRun = await service.validateSelected(['aio-1']);
      expect(dryRun.items[0].outcome).toBe('CATEGORY_REQUIRED');

      const published = await service.publish('aio-1');
      expect(published.status).toBe(AiOfferFromOnlineStatus.CATEGORY_REQUIRED);
    });

    it('an unknown id is reported as a per-item failure, not a thrown error for the whole batch', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(null);

      const result = await service.validateSelected(['missing-1']);

      expect(result.otherFailures).toBe(1);
      expect(result.items[0].message).toMatch(/not found/i);
    });

    it('rejects an empty selection', async () => {
      await expect(service.validateSelected([])).rejects.toThrow(/at least one offer/);
    });
  });

  describe('publishSelected — bulk, independent per offer', () => {
    it('publishes the successes even when others fail or are flagged as duplicates — no rollback of the ones that worked', async () => {
      prisma.aiOfferFromOnline.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(makeOffer({ id: where.id, matched_business_id: where.id === 'dup-1' ? 'biz-2' : 'biz-1' })),
      );
      duplicateDetection.check.mockImplementation(({ businessId }: any) =>
        Promise.resolve(
          businessId === 'biz-2'
            ? { confidence: 'HIGH', duplicateOfferId: 'existing-9', score: 0.9, reasons: ['same_business'] }
            : LOW,
        ),
      );
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-x' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));
      offerPublisherService.publishDraft.mockImplementation(() => {
        // Only the 4th offer fails the publisher's own validation.
        if (offerPublisherService.publishDraft.mock.calls.length === 3) return Promise.reject(new Error('Cannot publish — missing: cover image'));
        return Promise.resolve({});
      });

      const result = await service.publishSelected(['ok-1', 'ok-2', 'dup-1', 'bad-1']);

      expect(result.published).toBe(2);
      expect(result.duplicate).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.results).toHaveLength(4);
      expect(result.results.find((r) => r.id === 'dup-1')!.outcome).toBe('DUPLICATE');
      expect(result.results.find((r) => r.id === 'bad-1')!.outcome).toBe('FAILED');
      expect(result.results.find((r) => r.id === 'bad-1')!.error).toMatch(/missing: cover image/);
    });

    it('marks a genuinely failed offer FAILED with a reason so it stays retryable, but does NOT mark a duplicate-flagged one failed', async () => {
      prisma.aiOfferFromOnline.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(makeOffer({ id: where.id, matched_business_id: where.id === 'dup-1' ? 'biz-2' : 'biz-1' })),
      );
      duplicateDetection.check.mockImplementation(({ businessId }: any) =>
        Promise.resolve(
          businessId === 'biz-2' ? { confidence: 'HIGH', duplicateOfferId: 'existing-9', score: 0.9, reasons: [] } : LOW,
        ),
      );
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-x' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));
      offerPublisherService.approveDraft.mockRejectedValueOnce(new Error('Cannot approve — missing: description'));

      await service.publishSelected(['bad-1', 'dup-1']);

      const failedUpdate = prisma.aiOfferFromOnline.update.mock.calls.find(
        (c: any) => c[0].data.status === AiOfferFromOnlineStatus.FAILED,
      );
      expect(failedUpdate).toBeDefined();
      expect(failedUpdate[0].data.failure_reason).toMatch(/missing: description/);
      // Exactly one FAILED write — the duplicate-flagged offer is not marked failed.
      expect(
        prisma.aiOfferFromOnline.update.mock.calls.filter((c: any) => c[0].data.status === AiOfferFromOnlineStatus.FAILED),
      ).toHaveLength(1);
    });

    it('rejects an empty selection', async () => {
      await expect(service.publishSelected([])).rejects.toThrow(/at least one offer/);
    });

    it('reports CATEGORY_REQUIRED/EXPIRED as their own outcomes, and publishes a price-less offer normally alongside them', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      prisma.aiOfferFromOnline.findUnique.mockImplementation(({ where }: any) => {
        const byId: Record<string, unknown> = {
          'priceless-1': makeOffer({ id: 'priceless-1', matched_business_id: 'biz-1', offer_price: null }),
          'cat-1': makeOffer({ id: 'cat-1', matched_business_id: 'biz-1', category: 'quantum-widgets' }),
          'expired-1': makeOffer({ id: 'expired-1', matched_business_id: 'biz-1', validity_end: yesterday }),
        };
        return Promise.resolve(byId[where.id]);
      });
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-x' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.publishSelected(['priceless-1', 'cat-1', 'expired-1']);

      expect(result.published).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.categoryRequired).toBe(1);
      expect(result.expired).toBe(1);
      expect(result.results.find((r) => r.id === 'priceless-1')!.outcome).toBe('PUBLISHED');
      expect(result.results.find((r) => r.id === 'cat-1')!.outcome).toBe('CATEGORY_REQUIRED');
      expect(result.results.find((r) => r.id === 'expired-1')!.outcome).toBe('EXPIRED');
      // These are review states, not failures — no FAILED write happened.
      expect(
        prisma.aiOfferFromOnline.update.mock.calls.filter((c: any) => c[0].data.status === AiOfferFromOnlineStatus.FAILED),
      ).toHaveLength(0);
    });
  });

  describe('reject', () => {
    it('marks REJECTED and never creates a Business or Offer', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer());
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));

      const result = await service.reject('aio-1', 'Not a real offer');

      expect(result.status).toBe(AiOfferFromOnlineStatus.REJECTED);
      expect(result.rejection_reason).toBe('Not a real offer');
      expect(prisma.offer.create).not.toHaveBeenCalled();
      expect(draftCreation.matchOrCreateBusiness).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('is a plain read — no Collector call is possible, this service has no client for one', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer());

      const result = await service.get('aio-1');

      expect(result.id).toBe('aio-1');
      expect((service as unknown as Record<string, unknown>).collectorClient).toBeUndefined();
    });
  });
});
