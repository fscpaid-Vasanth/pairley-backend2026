import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OfferPublisherService } from './offer-publisher.service';

describe('OfferPublisherService', () => {
  let prisma: {
    offer: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      count: jest.Mock;
    };
    business: { update: jest.Mock; delete: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let storage: { uploadFile: jest.Mock; deleteFile: jest.Mock };
  let fileValidation: { validate: jest.Mock; sanitizeFilename: jest.Mock };
  let draftCreation: {
    createPlaceholderDraft: jest.Mock;
    matchOrCreateBusiness: jest.Mock;
  };
  let service: OfferPublisherService;

  const business = (overrides: Record<string, unknown> = {}) => ({
    id: 'biz-1',
    business_name: 'Untitled Merchant',
    mobile: null,
    email: null,
    city: '',
    area: null,
    address: '',
    state: '',
    pincode: '',
    google_maps_link: null,
    owner_name: '',
    category: '',
    ...overrides,
  });

  const draftOffer = (overrides: Record<string, unknown> = {}) => ({
    id: 'offer-1',
    business_id: 'biz-1',
    offer_code: 1,
    status: 'DRAFT',
    title: 'Untitled offer',
    description: '',
    category: '',
    original_price: 0,
    offer_price: 0,
    required_people: 1,
    start_date: new Date(),
    end_date: new Date(),
    terms: null,
    rejection_reason: null,
    cover_image: null,
    gallery_images: [],
    whatsapp_number: null,
    business: business(),
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      offer: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      business: {
        update: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      // updateDraft runs entirely inside a transaction (the re-point and the
      // old-business cleanup must be strictly ordered — see the method's own
      // comment) — the mock tx client shares the same offer/business mocks
      // above so assertions can inspect calls made through either.
      $transaction: jest.fn().mockImplementation((cb) =>
        cb({ offer: prisma.offer, business: prisma.business }),
      ),
    };
    storage = {
      uploadFile: jest
        .fn()
        .mockResolvedValue('https://storage.example/covers/x.jpg'),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    };
    fileValidation = {
      validate: jest.fn(),
      sanitizeFilename: jest.fn((n: string) => n),
    };
    draftCreation = {
      createPlaceholderDraft: jest
        .fn()
        .mockResolvedValue({ businessId: 'biz-1', offerId: 'offer-1' }),
      matchOrCreateBusiness: jest
        .fn()
        .mockResolvedValue({ businessId: 'biz-2', created: true }),
    };
    service = new OfferPublisherService(
      prisma as any,
      storage as any,
      fileValidation,
      draftCreation as any,
    );
  });

  describe('createDraftsFromFiles', () => {
    const file = (name: string) =>
      ({
        originalname: name,
        buffer: Buffer.from('x'),
        mimetype: 'image/jpeg',
        size: 1,
      }) as Express.Multer.File;

    it('creates one placeholder draft per accepted image', async () => {
      const result = await service.createDraftsFromFiles([
        file('a.jpg'),
        file('b.jpg'),
      ]);
      expect(result.drafts).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
      expect(draftCreation.createPlaceholderDraft).toHaveBeenCalledTimes(2);
    });

    it('collects a per-file validation failure instead of failing the whole request', async () => {
      fileValidation.validate.mockImplementationOnce(() => {
        throw new Error('Unsupported file type');
      });
      const result = await service.createDraftsFromFiles([
        file('bad.txt'),
        file('good.jpg'),
      ]);
      expect(result.failed).toEqual([
        { fileName: 'bad.txt', error: 'Unsupported file type' },
      ]);
      expect(result.drafts).toHaveLength(1);
    });
  });

  describe('approveDraft', () => {
    it('rejects approval when required fields are still placeholder/empty, listing exactly what is missing', async () => {
      prisma.offer.findUnique.mockResolvedValue(draftOffer());
      await expect(service.approveDraft('offer-1')).rejects.toThrow(
        BadRequestException,
      );
      try {
        await service.approveDraft('offer-1');
      } catch (e) {
        expect((e as BadRequestException).message).toContain('title');
        expect((e as BadRequestException).message).toContain('merchant mobile');
      }
    });

    it('approves a fully-filled DRAFT, moving it to APPROVED', async () => {
      const complete = draftOffer({
        title: 'Real Offer',
        description: 'desc',
        category: 'Fitness',
        original_price: 1000,
        offer_price: 700,
        required_people: 1,
        cover_image: 'https://x/cover.jpg',
        business: business({
          mobile: '9876543210',
          city: 'Bangalore',
          address: '123 St',
        }),
      });
      prisma.offer.findUnique.mockResolvedValue(complete);
      prisma.offer.update.mockResolvedValue({
        ...complete,
        status: 'APPROVED',
      });

      const result = await service.approveDraft('offer-1');

      expect(prisma.offer.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'APPROVED' } }),
      );
      expect(result.status).toBe('APPROVED');
    });

    it('approves a BOGO-style offer with no original_price — that field is not required', async () => {
      const bogo = draftOffer({
        title: 'Buy 2 Get 1 Free',
        description: 'desc',
        category: 'Shopping',
        original_price: 0,
        offer_price: 999,
        required_people: 1,
        cover_image: 'https://x/cover.jpg',
        business: business({
          mobile: '9876543210',
          city: 'Bangalore',
          address: '123 St',
        }),
      });
      prisma.offer.findUnique.mockResolvedValue(bogo);
      prisma.offer.update.mockResolvedValue({ ...bogo, status: 'APPROVED' });

      const result = await service.approveDraft('offer-1');

      expect(result.status).toBe('APPROVED');
    });

    it('refuses to approve an offer that is not DRAFT', async () => {
      prisma.offer.findUnique.mockResolvedValue(
        draftOffer({ status: 'APPROVED' }),
      );
      await expect(service.approveDraft('offer-1')).rejects.toThrow(
        /Only a DRAFT offer can be approved/,
      );
    });

    // 2026-08-14 — regression coverage for a production bug: AI Offers From
    // Online creates a real Offer with offer_price: 0 (a "no verified
    // price" sentinel) for a price-less promotional offer, then calls
    // approveDraft(offerId, true) immediately. Without allowMissingPrice,
    // this check rejected every one of those offers with "missing:
    // offerPrice" — the whole "price is optional" feature silently failed
    // to publish anything without a real price.
    describe('allowMissingPrice — the AI Offers From Online 0-price sentinel', () => {
      it('still rejects a 0 offer_price by DEFAULT — Offer Publisher\'s own manual flow is unaffected', async () => {
        const zeroPrice = draftOffer({
          title: 'Real Offer',
          description: 'desc',
          category: 'Fitness',
          original_price: 1000,
          offer_price: 0,
          required_people: 1,
          cover_image: 'https://x/cover.jpg',
          business: business({ mobile: '9876543210', city: 'Bangalore', address: '123 St' }),
        });
        prisma.offer.findUnique.mockResolvedValue(zeroPrice);

        await expect(service.approveDraft('offer-1')).rejects.toThrow(/missing:.*offerPrice/);
      });

      it('approves a 0 offer_price when allowMissingPrice is true — the exact case that was broken', async () => {
        const zeroPrice = draftOffer({
          title: 'Buy One Get One Free',
          description: 'desc',
          category: 'Shopping',
          original_price: 0,
          offer_price: 0,
          required_people: 1,
          cover_image: 'https://x/cover.jpg',
          business: business({ mobile: '9876543210', city: 'Bangalore', address: '123 St' }),
        });
        prisma.offer.findUnique.mockResolvedValue(zeroPrice);
        prisma.offer.update.mockResolvedValue({ ...zeroPrice, status: 'APPROVED' });

        const result = await service.approveDraft('offer-1', true);

        expect(result.status).toBe('APPROVED');
      });

      it('allowMissingPrice does not waive any OTHER required field', async () => {
        const missingTitle = draftOffer({
          title: '',
          description: 'desc',
          category: 'Shopping',
          offer_price: 0,
          required_people: 1,
          cover_image: 'https://x/cover.jpg',
          business: business({ mobile: '9876543210', city: 'Bangalore', address: '123 St' }),
        });
        prisma.offer.findUnique.mockResolvedValue(missingTitle);

        await expect(service.approveDraft('offer-1', true)).rejects.toThrow(/missing:.*title/);
      });
    });
  });

  describe('publishDraft', () => {
    it('requires APPROVED status — refuses to publish straight from DRAFT', async () => {
      prisma.offer.findUnique.mockResolvedValue(
        draftOffer({ status: 'DRAFT' }),
      );
      await expect(service.publishDraft('offer-1')).rejects.toThrow(
        /Only Approved offers can be published/,
      );
      expect(prisma.offer.update).not.toHaveBeenCalled();
    });

    it('publishes an APPROVED offer to ACTIVE', async () => {
      const approved = draftOffer({ status: 'APPROVED' });
      prisma.offer.findUnique.mockResolvedValue(approved);
      prisma.offer.update.mockResolvedValue({ ...approved, status: 'ACTIVE' });

      const result = await service.publishDraft('offer-1');

      expect(prisma.offer.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'ACTIVE' } }),
      );
      expect(result.status).toBe('ACTIVE');
    });
  });

  describe('rejectDraft', () => {
    it.each(['DRAFT', 'APPROVED'])(
      'rejects a %s draft, persisting the reason',
      async (status) => {
        const offer = draftOffer({ status });
        prisma.offer.findUnique.mockResolvedValue(offer);
        prisma.offer.update.mockResolvedValue({
          ...offer,
          status: 'REJECTED',
          rejection_reason: 'blurry photo',
        });

        const result = await service.rejectDraft('offer-1', 'blurry photo');

        expect(prisma.offer.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { status: 'REJECTED', rejection_reason: 'blurry photo' },
          }),
        );
        expect(result.rejectionReason).toBe('blurry photo');
      },
    );

    it('refuses to reject an already-published offer', async () => {
      prisma.offer.findUnique.mockResolvedValue(
        draftOffer({ status: 'ACTIVE' }),
      );
      await expect(service.rejectDraft('offer-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('updateDraft', () => {
    it('reverts an APPROVED draft back to DRAFT when edited, clearing any rejection reason', async () => {
      const approved = draftOffer({
        status: 'APPROVED',
        rejection_reason: null,
      });
      prisma.offer.findUnique.mockResolvedValue(approved);
      prisma.offer.update.mockResolvedValue({ ...approved, status: 'DRAFT' });

      const result = await service.updateDraft('offer-1', {
        title: 'New title',
      });

      expect(prisma.offer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'DRAFT',
            rejection_reason: null,
          }),
        }),
      );
      expect(result.status).toBe('DRAFT');
    });

    it('does not touch status when editing an already-DRAFT offer', async () => {
      const draft = draftOffer({ status: 'DRAFT' });
      prisma.offer.findUnique.mockResolvedValue(draft);
      prisma.offer.update.mockResolvedValue(draft);

      await service.updateDraft('offer-1', { title: 'New title' });

      expect(prisma.offer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'DRAFT' }),
        }),
      );
    });

    // Regression test: Business.email is @unique. The admin form always
    // submits `email: ""` when the field is left blank (never omits it),
    // and `fields.email ?? offer.business.email` treated that empty string
    // as a real value to write — fine for the first business ever saved
    // with a blank email, a P2002 unique-constraint crash (surfacing as a
    // raw "Internal server error" 500) for every one after it, since
    // Postgres treats '' as a real, colliding value unlike NULL. This
    // happened for real in production — reproduced live, root-caused to
    // this exact line, and the fix verified against a fresh throwaway
    // draft before being applied here.
    it('normalises a blank email to null rather than writing the literal empty string', async () => {
      const draft = draftOffer({ status: 'DRAFT', business: business({ email: null }) });
      prisma.offer.findUnique.mockResolvedValue(draft);
      prisma.offer.update.mockResolvedValue(draft);

      await service.updateDraft('offer-1', {
        address: 'JP Nagar',
        email: '',
      });

      expect(prisma.business.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: null }),
        }),
      );
    });

    it('leaves the stored email untouched when the field is not supplied at all', async () => {
      const draft = draftOffer({
        status: 'DRAFT',
        business: business({ email: 'merchant@example.com' }),
      });
      prisma.offer.findUnique.mockResolvedValue(draft);
      prisma.offer.update.mockResolvedValue(draft);

      await service.updateDraft('offer-1', { address: 'JP Nagar' });

      expect(prisma.business.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'merchant@example.com' }),
        }),
      );
    });

    it('trims and keeps a real, non-blank email', async () => {
      const draft = draftOffer({ status: 'DRAFT', business: business({ email: null }) });
      prisma.offer.findUnique.mockResolvedValue(draft);
      prisma.offer.update.mockResolvedValue(draft);

      await service.updateDraft('offer-1', { email: '  merchant@example.com  ' });

      expect(prisma.business.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'merchant@example.com' }),
        }),
      );
    });

    it('refuses to edit an already-published (ACTIVE) offer', async () => {
      prisma.offer.findUnique.mockResolvedValue(
        draftOffer({ status: 'ACTIVE' }),
      );
      await expect(
        service.updateDraft('offer-1', { title: 'x' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('re-parents the offer onto a matched business when the typed mobile differs, and cleans up the now-empty placeholder business', async () => {
      const offer = draftOffer({
        business_id: 'biz-1',
        business: business({ mobile: null }),
      });
      prisma.offer.findUnique.mockResolvedValue(offer);
      // Counted AFTER the offer has already been re-pointed away from
      // biz-1 (see the ordering test below) — 0 means biz-1 is now
      // genuinely orphaned, not "1" as if this offer still counted.
      prisma.offer.count.mockResolvedValue(0);
      prisma.offer.update.mockResolvedValue({ ...offer, business_id: 'biz-2' });

      await service.updateDraft('offer-1', { mobile: '9876543210' });

      expect(draftCreation.matchOrCreateBusiness).toHaveBeenCalledWith(
        expect.objectContaining({ mobile: '9876543210' }),
        expect.anything(),
      );
      expect(prisma.business.delete).toHaveBeenCalledWith({
        where: { id: 'biz-1' },
      });
      expect(prisma.offer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ business_id: 'biz-2' }),
        }),
      );
    });

    it('does not delete the placeholder business if it still has other offers', async () => {
      const offer = draftOffer({
        business_id: 'biz-1',
        business: business({ mobile: null }),
      });
      prisma.offer.findUnique.mockResolvedValue(offer);
      prisma.offer.count.mockResolvedValue(1);
      prisma.offer.update.mockResolvedValue(offer);

      await service.updateDraft('offer-1', { mobile: '9876543210' });

      expect(prisma.business.delete).not.toHaveBeenCalled();
    });

    // Regression test: Offer.business is onDelete: Cascade. Deleting the old
    // business BEFORE the offer stops referencing it cascades and destroys
    // the very offer being saved — this happened for real during manual
    // verification (Prisma P2025 "No record was found for an update" on the
    // very next line). The fix re-points the offer to the new business
    // first, then only cleans up the old one — assert that call order here
    // so it can't regress silently.
    it('re-points the offer to the new business BEFORE deleting the old (empty) one', async () => {
      const offer = draftOffer({
        business_id: 'biz-1',
        business: business({ mobile: null }),
      });
      prisma.offer.findUnique.mockResolvedValue(offer);
      prisma.offer.count.mockResolvedValue(0);
      prisma.offer.update.mockResolvedValue({ ...offer, business_id: 'biz-2' });

      const callOrder: string[] = [];
      prisma.offer.update.mockImplementation((...args) => {
        callOrder.push('offer.update');
        return Promise.resolve({ ...offer, business_id: 'biz-2', ...args[0].data });
      });
      prisma.business.delete.mockImplementation(() => {
        callOrder.push('business.delete');
        return Promise.resolve({});
      });

      await service.updateDraft('offer-1', { mobile: '9876543210' });

      expect(callOrder).toEqual(['offer.update', 'business.delete']);
    });

    it('runs the re-point and cleanup inside a single transaction', async () => {
      const offer = draftOffer({
        business_id: 'biz-1',
        business: business({ mobile: null }),
      });
      prisma.offer.findUnique.mockResolvedValue(offer);
      prisma.offer.count.mockResolvedValue(0);
      prisma.offer.update.mockResolvedValue({ ...offer, business_id: 'biz-2' });

      await service.updateDraft('offer-1', { mobile: '9876543210' });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteDraft', () => {
    it('deletes a DRAFT offer, its images, and orphan-cleans the business if it has no other offers', async () => {
      const offer = draftOffer({
        cover_image: 'https://x/cover.jpg',
        gallery_images: ['https://x/g1.jpg'],
      });
      prisma.offer.findUnique.mockResolvedValue(offer);
      prisma.offer.count.mockResolvedValue(0);

      await service.deleteDraft('offer-1');

      expect(storage.deleteFile).toHaveBeenCalledWith('https://x/cover.jpg');
      expect(storage.deleteFile).toHaveBeenCalledWith('https://x/g1.jpg');
      expect(prisma.offer.delete).toHaveBeenCalledWith({
        where: { id: 'offer-1' },
      });
      expect(prisma.business.delete).toHaveBeenCalledWith({
        where: { id: 'biz-1' },
      });
    });

    it('leaves the business alone if it still has other offers', async () => {
      prisma.offer.findUnique.mockResolvedValue(draftOffer());
      prisma.offer.count.mockResolvedValue(1);

      await service.deleteDraft('offer-1');

      expect(prisma.business.delete).not.toHaveBeenCalled();
    });

    it('refuses to delete an APPROVED or ACTIVE offer', async () => {
      prisma.offer.findUnique.mockResolvedValue(
        draftOffer({ status: 'APPROVED' }),
      );
      await expect(service.deleteDraft('offer-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.offer.delete).not.toHaveBeenCalled();
    });
  });

  describe('getDraft', () => {
    it('throws NotFoundException for an unknown id', async () => {
      prisma.offer.findUnique.mockResolvedValue(null);
      await expect(service.getDraft('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('searchBusinesses', () => {
    it('returns nothing for a query shorter than 2 characters, without querying the database', async () => {
      const result = await service.searchBusinesses('a');
      expect(result).toEqual([]);
      expect(prisma.business.findMany).not.toHaveBeenCalled();
    });
  });
});
