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
      expect(offerPublisherService.approveDraft).toHaveBeenCalledWith('real-offer-1');
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
        expect(offerPublisherService.approveDraft).toHaveBeenCalledWith('real-offer-1');
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
