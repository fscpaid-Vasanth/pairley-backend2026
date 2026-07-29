import { OfferStatus, OfferType, Source } from '@prisma/client';
import { ReviewQueueService, deriveReviewStatus } from './review-queue.service';
import { PrismaService } from '../prisma/prisma.service';

describe('deriveReviewStatus', () => {
  it.each([
    [{ status: OfferStatus.DRAFT, review_required: true }, 'REVIEW_REQUIRED'],
    [{ status: OfferStatus.ACTIVE, review_required: false }, 'APPROVED'],
    [{ status: OfferStatus.REJECTED, review_required: false }, 'REJECTED'],
    [{ status: OfferStatus.ARCHIVED, review_required: false }, 'TAKEN_DOWN'],
  ] as const)('derives %s -> %s', (offer, expected) => {
    expect(deriveReviewStatus(offer)).toBe(expected);
  });
});

describe('ReviewQueueService', () => {
  let offerFindMany: jest.Mock;
  let offerCount: jest.Mock;
  let offerFindUnique: jest.Mock;
  let offerUpdate: jest.Mock;
  let businessUpdate: jest.Mock;
  let offerVersionCount: jest.Mock;
  let offerVersionCreate: jest.Mock;
  let prisma: {
    offer: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    business: { update: jest.Mock };
    offerVersion: { count: jest.Mock; create: jest.Mock; findMany: jest.Mock };
    importJob: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: ReviewQueueService;

  const candidateOffer = {
    id: 'offer-1',
    title: 'Imported Offer',
    business_id: 'business-1',
    source: Source.WEBSITE,
    status: OfferStatus.DRAFT,
    review_required: true,
    confidence_score: 0.4,
    imported_at: new Date('2026-01-01'),
    original_price: 0,
    offer_price: 0,
    category: 'shopping',
    description: 'No description available.',
    cover_image: null,
    // Module 14 Phase 1 — the coherence checks on saveDraft/approve compare
    // a submitted value against the stored one, so these have to be real.
    subtitle: null,
    required_people: 1,
    start_date: new Date('2026-01-01'),
    end_date: new Date('2026-01-31'),
    original_import_url: 'https://example.com/',
    duplicate_of_offer_id: null,
    duplicate_score: null,
    duplicate_reasons: [],
    offer_type: OfferType.STANDARD,
    tags: [],
    keywords: [],
    enrichment_status: 'NOT_ENRICHED',
    enrichment_confidence: null,
    enrichment_metadata: null,
    business: {
      business_name: 'example.com (imported)',
      duplicate_of_business_id: null,
      duplicate_score: null,
      duplicate_reasons: [],
    },
  };

  beforeEach(() => {
    offerFindMany = jest.fn().mockResolvedValue([candidateOffer]);
    offerCount = jest.fn().mockResolvedValue(1);
    offerFindUnique = jest.fn().mockResolvedValue(candidateOffer);
    offerUpdate = jest
      .fn()
      .mockImplementation(({ data }) =>
        Promise.resolve({ ...candidateOffer, ...data }),
      );
    businessUpdate = jest.fn().mockResolvedValue({});
    offerVersionCount = jest.fn().mockResolvedValue(1);
    offerVersionCreate = jest.fn().mockResolvedValue({ id: 'version-2' });

    prisma = {
      offer: {
        findMany: offerFindMany,
        count: offerCount,
        findUnique: offerFindUnique,
        update: offerUpdate,
      },
      business: { update: businessUpdate },
      // Module 14 Phase 1 — getCandidate looks up the originating import
      // job so the review screen can show the raw extraction next to the
      // Pairley-formatted result. Null is the realistic default: a
      // candidate whose job row has been pruned still has to render.
      importJob: { findFirst: jest.fn().mockResolvedValue(null) },
      offerVersion: {
        count: offerVersionCount,
        create: offerVersionCreate,
        findMany: jest.fn().mockResolvedValue([]),
      },
      // approve() uses the callback form ($transaction(async tx => ...)),
      // listCandidates uses the array form ($transaction([...])) — support
      // both, handing the callback form the same mock object as `tx` since
      // these tests don't need real transaction isolation.
      $transaction: jest
        .fn()
        .mockImplementation((arg: unknown) =>
          typeof arg === 'function'
            ? (arg as (tx: unknown) => unknown)(prisma)
            : Promise.all(arg as Promise<unknown>[]),
        ),
    };

    service = new ReviewQueueService(prisma as unknown as PrismaService);
  });

  describe('listCandidates', () => {
    it('returns paginated results with derived review status and warnings', async () => {
      const result = await service.listCandidates({ page: 1, pageSize: 20 });
      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        id: 'offer-1',
        business_name: 'example.com (imported)',
        review_status: 'REVIEW_REQUIRED',
        description: 'No description available.',
        source_file_url: 'https://example.com/',
      });
      expect(result.items[0].warnings).toEqual(
        expect.arrayContaining([
          'No price detected',
          'No image detected',
          'No description detected',
        ]),
      );
    });

    it('excludes merchant-created (MANUAL) offers via the base where clause', async () => {
      await service.listCandidates({ page: 1, pageSize: 20 });
      const expectedArg = {
        where: expect.objectContaining({
          source: { not: Source.MANUAL },
        }) as unknown,
      };
      expect(offerFindMany).toHaveBeenCalledWith(
        expect.objectContaining(expectedArg),
      );
    });

    it('clamps page size to the 1-100 range', async () => {
      await service.listCandidates({ page: 1, pageSize: 500 });
      expect(offerFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it('requests the business duplicate fields alongside business_name (Module 11 Phase 2)', async () => {
      await service.listCandidates({ page: 1, pageSize: 20 });
      expect(offerFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            business: {
              select: {
                business_name: true,
                duplicate_of_business_id: true,
                duplicate_score: true,
                duplicate_reasons: true,
              },
            },
          },
        }) as unknown,
      );
    });

    it('surfaces offer-level duplicate fields and warning when flagged', async () => {
      offerFindMany.mockResolvedValue([
        {
          ...candidateOffer,
          duplicate_of_offer_id: 'offer-original',
          duplicate_score: 0.82,
          duplicate_reasons: ['Title is an exact or near-exact match'],
        },
      ]);
      const result = await service.listCandidates({ page: 1, pageSize: 20 });
      expect(result.items[0]).toMatchObject({
        duplicate_of_offer_id: 'offer-original',
        duplicate_score: 0.82,
        duplicate_reasons: ['Title is an exact or near-exact match'],
      });
      expect(result.items[0].warnings).toContain(
        'Possible duplicate offer detected — please verify',
      );
    });

    it('surfaces business-level duplicate fields and warning when flagged', async () => {
      offerFindMany.mockResolvedValue([
        {
          ...candidateOffer,
          business: {
            ...candidateOffer.business,
            duplicate_of_business_id: 'business-original',
            duplicate_score: 0.7,
            duplicate_reasons: [
              'Business name is an exact or near-exact match',
            ],
          },
        },
      ]);
      const result = await service.listCandidates({ page: 1, pageSize: 20 });
      expect(result.items[0]).toMatchObject({
        business_duplicate_of_id: 'business-original',
        business_duplicate_score: 0.7,
        business_duplicate_reasons: [
          'Business name is an exact or near-exact match',
        ],
      });
      expect(result.items[0].warnings).toContain(
        'Possible duplicate business detected — please verify',
      );
    });

    it('omits both duplicate warnings when nothing was flagged — unchanged Module 9/10 behavior', async () => {
      const result = await service.listCandidates({ page: 1, pageSize: 20 });
      expect(result.items[0].duplicate_of_offer_id).toBeNull();
      expect(result.items[0].warnings).not.toContain(
        'Possible duplicate offer detected — please verify',
      );
      expect(result.items[0].warnings).not.toContain(
        'Possible duplicate business detected — please verify',
      );
    });
  });

  describe('getCandidate', () => {
    it('throws NotFound for a missing offer', async () => {
      offerFindUnique.mockResolvedValue(null);
      await expect(service.getCandidate('missing')).rejects.toThrow(
        'Candidate offer not found',
      );
    });

    it('throws Forbidden for a merchant-created (MANUAL) offer', async () => {
      offerFindUnique.mockResolvedValue({
        ...candidateOffer,
        source: Source.MANUAL,
      });
      await expect(service.getCandidate('offer-1')).rejects.toThrow(
        'This offer was not AI-imported',
      );
    });

    it('includes offer_type/tags/keywords/enrichment fields — needed by the AI Suggestions panel (Module 11 Phase 4)', async () => {
      offerFindUnique.mockResolvedValue({
        ...candidateOffer,
        offer_type: OfferType.PERCENTAGE_DISCOUNT,
        tags: ['diwali', 'sale'],
        keywords: ['diwali', 'sale', 'dining'],
        enrichment_status: 'ENRICHED',
        enrichment_confidence: 0.75,
        enrichment_metadata: { category: { suggested: 'dining' } },
      });
      const result = await service.getCandidate('offer-1');
      expect(result).toMatchObject({
        offer_type: OfferType.PERCENTAGE_DISCOUNT,
        tags: ['diwali', 'sale'],
        keywords: ['diwali', 'sale', 'dining'],
        enrichment_status: 'ENRICHED',
        enrichment_confidence: 0.75,
        enrichment_metadata: { category: { suggested: 'dining' } },
      });
    });
  });

  describe('approve / reject / takedown', () => {
    it('approve() sets ACTIVE + review_required=false and logs an audit entry with the admin id', async () => {
      const result = await service.approve('offer-1', 'admin-42');
      expect(offerUpdate).toHaveBeenCalledWith({
        where: { id: 'offer-1' },
        data: { status: OfferStatus.ACTIVE, review_required: false },
      });
      const versionData = {
        data: expect.objectContaining({
          change_type: 'REVIEW_APPROVED',
          changed_by: 'admin-42',
        }) as unknown,
      };
      expect(offerVersionCreate).toHaveBeenCalledWith(versionData);
      expect(result.status).toBe(OfferStatus.ACTIVE);
    });

    describe('approve() with overrides (Module 11 Phase 4)', () => {
      it('applies category/offerType/tags/keywords overrides atomically with the approval', async () => {
        await service.approve('offer-1', 'admin-42', {
          category: 'dining',
          offerType: OfferType.PERCENTAGE_DISCOUNT,
          tags: ['diwali', 'sale'],
          keywords: ['diwali', 'sale', 'dining'],
        });
        expect(offerUpdate).toHaveBeenCalledWith({
          where: { id: 'offer-1' },
          data: {
            status: OfferStatus.ACTIVE,
            review_required: false,
            category: 'dining',
            offer_type: OfferType.PERCENTAGE_DISCOUNT,
            tags: ['diwali', 'sale'],
            keywords: ['diwali', 'sale', 'dining'],
          },
        });
      });

      it('atomically updates Business.business_type when a merchantType override is given', async () => {
        await service.approve('offer-1', 'admin-42', {
          merchantType: 'Restaurant / Food Service',
        });
        expect(businessUpdate).toHaveBeenCalledWith({
          where: { id: 'business-1' },
          data: { business_type: 'Restaurant / Food Service' },
        });
      });

      it('does not touch Business at all when no merchantType override is given', async () => {
        await service.approve('offer-1', 'admin-42', { category: 'dining' });
        expect(businessUpdate).not.toHaveBeenCalled();
      });

      it('leaves every field unchanged when overrides is omitted entirely — unchanged Phase 1-3 behavior', async () => {
        await service.approve('offer-1', 'admin-42');
        expect(offerUpdate).toHaveBeenCalledWith({
          where: { id: 'offer-1' },
          data: { status: OfferStatus.ACTIVE, review_required: false },
        });
        expect(businessUpdate).not.toHaveBeenCalled();
      });

      it('snapshots the pre-approval offer state in the version history, not the post-override state', async () => {
        await service.approve('offer-1', 'admin-42', { category: 'dining' });
        expect(offerVersionCreate).toHaveBeenCalledWith({
          data: expect.objectContaining({
            snapshot: expect.objectContaining({
              category: 'shopping',
            }) as unknown,
          }) as unknown,
        });
      });
    });

    describe('full-field editing (Module 14 Phase 1)', () => {
      it('applies core offer content overrides alongside the approval', async () => {
        await service.approve('offer-1', 'admin-42', {
          title: 'Spec Gym — 6 Months Monsoon Offer',
          description: 'Six months of full gym access.',
          subtitle: 'Monsoon special',
          originalPrice: 30000,
          offerPrice: 6000,
          requiredPeople: 5,
          coverImage: 'https://cdn.example.com/gym.jpg',
        });
        expect(offerUpdate).toHaveBeenCalledWith({
          where: { id: 'offer-1' },
          data: expect.objectContaining({
            title: 'Spec Gym — 6 Months Monsoon Offer',
            description: 'Six months of full gym access.',
            subtitle: 'Monsoon special',
            original_price: 30000,
            offer_price: 6000,
            required_people: 5,
            cover_image: 'https://cdn.example.com/gym.jpg',
            status: OfferStatus.ACTIVE,
          }) as unknown,
        });
      });

      it('applies business identity and contact overrides in the same transaction', async () => {
        await service.approve('offer-1', 'admin-42', {
          businessName: 'Spec Gym',
          businessCategory: 'Gym',
          businessMobile: '9876543210',
          businessAddress: '12 Anna Nagar',
          businessCity: 'Chennai',
          businessState: 'Tamil Nadu',
          businessPincode: '600040',
          businessWebsite: 'https://specgym.in',
          businessGstNumber: '33AAAAA0000A1Z5',
        });
        expect(businessUpdate).toHaveBeenCalledWith({
          where: { id: 'business-1' },
          data: {
            business_name: 'Spec Gym',
            category: 'Gym',
            mobile: '9876543210',
            address: '12 Anna Nagar',
            city: 'Chennai',
            state: 'Tamil Nadu',
            pincode: '600040',
            website: 'https://specgym.in',
            gst_number: '33AAAAA0000A1Z5',
          },
        });
      });

      // An extraction that produced junk tags should be clearable. Treating
      // [] as "no override" would make an admin unable to empty a field.
      it('treats an explicitly empty array as a real edit, not as "unchanged"', async () => {
        await service.approve('offer-1', 'admin-42', { tags: [] });
        expect(offerUpdate).toHaveBeenCalledWith({
          where: { id: 'offer-1' },
          data: expect.objectContaining({ tags: [] }) as unknown,
        });
      });

      describe('coherence checks', () => {
        it('rejects an offer price above the original price', async () => {
          await expect(
            service.approve('offer-1', 'admin-42', {
              originalPrice: 1000,
              offerPrice: 2000,
            }),
          ).rejects.toThrow('cannot be higher than the original price');
          expect(offerUpdate).not.toHaveBeenCalled();
        });

        // Only one side of the pair is submitted — the check has to compare
        // against what's stored, or half an edit slips through.
        it('compares a submitted price against the stored one when only one side is edited', async () => {
          offerFindUnique.mockResolvedValue({
            ...candidateOffer,
            original_price: 1000,
            offer_price: 800,
          });
          await expect(
            service.approve('offer-1', 'admin-42', { offerPrice: 1500 }),
          ).rejects.toThrow('cannot be higher than the original price');
        });

        it('rejects an end date that is not after the start date', async () => {
          await expect(
            service.approve('offer-1', 'admin-42', {
              startDate: new Date('2026-03-01'),
              endDate: new Date('2026-02-01'),
            }),
          ).rejects.toThrow('End date must be after the start date');
        });

        it('accepts a coherent price and date edit', async () => {
          await expect(
            service.approve('offer-1', 'admin-42', {
              originalPrice: 30000,
              offerPrice: 6000,
              startDate: new Date('2026-02-01'),
              endDate: new Date('2026-08-01'),
            }),
          ).resolves.toBeDefined();
        });
      });
    });

    describe('saveDraft (Module 14 Phase 1)', () => {
      it('persists edits without publishing — the candidate stays in the queue', async () => {
        await service.saveDraft('offer-1', 'admin-42', { title: 'Corrected' });
        expect(offerUpdate).toHaveBeenCalledWith({
          where: { id: 'offer-1' },
          data: { title: 'Corrected' },
        });
      });

      it('never sets status or review_required', async () => {
        await service.saveDraft('offer-1', 'admin-42', { category: 'dining' });
        const data = offerUpdate.mock.calls[0][0].data as Record<
          string,
          unknown
        >;
        expect(data).not.toHaveProperty('status');
        expect(data).not.toHaveProperty('review_required');
      });

      it('records a distinct audit change type, so a draft is tellable from an approval', async () => {
        await service.saveDraft('offer-1', 'admin-42', { title: 'Corrected' });
        expect(offerVersionCreate).toHaveBeenCalledWith({
          data: expect.objectContaining({
            change_type: 'REVIEW_DRAFT_SAVED',
            changed_by: 'admin-42',
          }) as unknown,
        });
      });

      it('updates the business too, exactly as approve does', async () => {
        await service.saveDraft('offer-1', 'admin-42', {
          businessName: 'Spec Gym',
        });
        expect(businessUpdate).toHaveBeenCalledWith({
          where: { id: 'business-1' },
          data: { business_name: 'Spec Gym' },
        });
      });

      it('applies the same coherence checks as approve', async () => {
        await expect(
          service.saveDraft('offer-1', 'admin-42', {
            originalPrice: 100,
            offerPrice: 500,
          }),
        ).rejects.toThrow('cannot be higher than the original price');
      });

      it('rejects a merchant-created (MANUAL) offer, like every other transition', async () => {
        offerFindUnique.mockResolvedValue({
          ...candidateOffer,
          source: Source.MANUAL,
        });
        await expect(
          service.saveDraft('offer-1', 'admin-42', { title: 'x' }),
        ).rejects.toThrow('not AI-imported');
      });
    });

    it('reject() sets REJECTED and stores the reason in the version snapshot', async () => {
      await service.reject('offer-1', 'admin-42', 'Pricing looks fake');
      expect(offerUpdate).toHaveBeenCalledWith({
        where: { id: 'offer-1' },
        data: { status: OfferStatus.REJECTED, review_required: false },
      });
      const versionData = {
        data: expect.objectContaining({
          change_type: 'REVIEW_REJECTED',
          snapshot: expect.objectContaining({
            _reason: 'Pricing looks fake',
          }) as unknown,
        }) as unknown,
      };
      expect(offerVersionCreate).toHaveBeenCalledWith(versionData);
    });

    it('takedown() sets ARCHIVED (soft — not deleted) with an audit entry', async () => {
      const result = await service.takedown('offer-1', 'admin-7');
      expect(offerUpdate).toHaveBeenCalledWith({
        where: { id: 'offer-1' },
        data: { status: OfferStatus.ARCHIVED, review_required: false },
      });
      const versionData = {
        data: expect.objectContaining({
          change_type: 'REVIEW_TAKEDOWN',
        }) as unknown,
      };
      expect(offerVersionCreate).toHaveBeenCalledWith(versionData);
      expect(result.status).toBe(OfferStatus.ARCHIVED);
    });

    it('is reversible — approving after a prior rejection is a normal, unrestricted transition', async () => {
      offerFindUnique.mockResolvedValue({
        ...candidateOffer,
        status: OfferStatus.REJECTED,
        review_required: false,
      });
      const result = await service.approve('offer-1', 'admin-42');
      expect(result.status).toBe(OfferStatus.ACTIVE);
    });

    it('rejects transitioning a merchant-created (MANUAL) offer', async () => {
      offerFindUnique.mockResolvedValue({
        ...candidateOffer,
        source: Source.MANUAL,
      });
      await expect(service.approve('offer-1', 'admin-42')).rejects.toThrow(
        'not AI-imported',
      );
    });
  });

  describe('bulk operations', () => {
    it('bulkApprove reports per-id success, continuing past individual failures', async () => {
      offerFindUnique
        .mockResolvedValueOnce(candidateOffer)
        .mockResolvedValueOnce(null); // second id doesn't exist

      const result = await service.bulkApprove(
        ['offer-1', 'offer-missing'],
        'admin-42',
      );
      expect(result.succeeded).toEqual(['offer-1']);
      expect(result.failed).toEqual([
        { id: 'offer-missing', error: 'Candidate offer not found' },
      ]);
    });

    it('bulkReject applies the same reason to every id', async () => {
      const result = await service.bulkReject(
        ['offer-1'],
        'admin-42',
        'duplicate import',
      );
      expect(result.succeeded).toEqual(['offer-1']);
      const versionData = {
        data: expect.objectContaining({
          snapshot: expect.objectContaining({
            _reason: 'duplicate import',
          }) as unknown,
        }) as unknown,
      };
      expect(offerVersionCreate).toHaveBeenCalledWith(versionData);
    });
  });
});
