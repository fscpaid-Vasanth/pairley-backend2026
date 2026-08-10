import { AiOfferFromOnlineStatus, OfferStatus } from '@prisma/client';
import { AiOffersFromOnlineService } from './ai-offers-from-online.service';
import { CategoryService } from '../common/taxonomy/category.service';

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

    service = new AiOffersFromOnlineService(
      prisma,
      storage as any,
      draftCreation as any,
      offerPublisherService as any,
      new CategoryService(),
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

    it('REFUSES an export with no offer price — a price-less offer cannot have an approved banner and must be corrected in the Collector', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(null);

      await expect(service.importExportedOffer({ ...VALID_EXPORT, offerPrice: undefined }, BANNER_FILE)).rejects.toThrow(/offerPrice is required/);
      expect(prisma.aiOfferFromOnline.upsert).not.toHaveBeenCalled();
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
    it('refuses to publish until a merchant has been matched or created', async () => {
      prisma.aiOfferFromOnline.findUnique.mockResolvedValue(makeOffer({ matched_business_id: null, created_business_id: null }));

      await expect(service.publish('aio-1')).rejects.toThrow(/No business matched or created/);
      expect(prisma.offer.create).not.toHaveBeenCalled();
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
  });

  describe('publishSelected — bulk, independent per offer', () => {
    it('publishes the successes even when others fail — no rollback of the ones that worked', async () => {
      prisma.aiOfferFromOnline.findUnique.mockImplementation(({ where }: any) => {
        if (where.id === 'ok-1' || where.id === 'ok-2') return Promise.resolve(makeOffer({ id: where.id, matched_business_id: 'biz-1' }));
        if (where.id === 'no-merchant') return Promise.resolve(makeOffer({ id: where.id, matched_business_id: null, created_business_id: null }));
        return Promise.resolve(makeOffer({ id: where.id, matched_business_id: 'biz-1' }));
      });
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-x' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));
      offerPublisherService.publishDraft.mockImplementation(() => {
        // Only the 4th offer fails the publisher's own validation.
        if (offerPublisherService.publishDraft.mock.calls.length === 3) return Promise.reject(new Error('Cannot publish — missing: cover image'));
        return Promise.resolve({});
      });

      const result = await service.publishSelected(['ok-1', 'ok-2', 'no-merchant', 'bad-1']);

      expect(result.published).toBe(2);
      expect(result.needsMerchant).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.results).toHaveLength(4);
      expect(result.results.find((r) => r.id === 'no-merchant')!.outcome).toBe('NEEDS_MERCHANT');
      expect(result.results.find((r) => r.id === 'bad-1')!.outcome).toBe('FAILED');
      expect(result.results.find((r) => r.id === 'bad-1')!.error).toMatch(/missing: cover image/);
    });

    it('marks a genuinely failed offer FAILED with a reason so it stays retryable, but does NOT mark a needs-merchant one failed', async () => {
      prisma.aiOfferFromOnline.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(makeOffer({ id: where.id, matched_business_id: where.id === 'no-merchant' ? null : 'biz-1' })),
      );
      prisma.offer.create.mockResolvedValue({ id: 'real-offer-x' });
      prisma.aiOfferFromOnline.update.mockImplementation(({ data }: any) => Promise.resolve({ id: 'aio-1', ...data }));
      offerPublisherService.approveDraft.mockRejectedValueOnce(new Error('Cannot approve — missing: description'));

      await service.publishSelected(['bad-1', 'no-merchant']);

      const failedUpdate = prisma.aiOfferFromOnline.update.mock.calls.find(
        (c: any) => c[0].data.status === AiOfferFromOnlineStatus.FAILED,
      );
      expect(failedUpdate).toBeDefined();
      expect(failedUpdate[0].data.failure_reason).toMatch(/missing: description/);
      // Exactly one FAILED write — the needs-merchant offer is not marked failed.
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
