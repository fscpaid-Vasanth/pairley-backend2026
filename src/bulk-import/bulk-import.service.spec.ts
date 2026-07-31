import { BadRequestException } from '@nestjs/common';
import { BulkImportService } from './bulk-import.service';

function csvBuffer(rows: string[][]): Buffer {
  return Buffer.from(rows.map((r) => r.join(',')).join('\n'), 'utf8');
}

const HEADERS = [
  'Merchant Name',
  'Category',
  'Offer Title',
  'Offer Description',
  'Offer Type',
  'Original Price',
  'Offer Price',
  'Minimum Participants',
  'Valid From',
  'Valid Until',
  'Contact Number',
  'WhatsApp Number',
  'Email',
  'Website',
  'Address',
  'City',
  'State',
  'Pincode',
  'Latitude',
  'Longitude',
  'Google Maps Link',
  'Terms & Conditions',
  'Status',
];

const VALID_ROW = [
  'Spec Gym',
  'Fitness',
  '6 Month Pass',
  'Great deal',
  'STANDARD',
  '5000',
  '3000',
  '1',
  '2026-08-01',
  '2026-08-31',
  '9876543210',
  '',
  '',
  '',
  '123 Main St',
  'Bangalore',
  'Karnataka',
  '560001',
  '',
  '',
  '',
  '',
  '',
];

const INVALID_ROW = [
  '',
  'Fitness',
  '6 Month Pass',
  '',
  'STANDARD',
  '5000',
  '3000',
  '1',
  '2026-08-01',
  '2026-08-31',
  '9876543211',
  '',
  '',
  '',
  '123 Main St',
  'Bangalore',
  'Karnataka',
  '560001',
  '',
  '',
  '',
  '',
  '',
];

const csvFile = (rows: string[][]) =>
  ({
    originalname: 'offers.csv',
    mimetype: 'text/csv',
    size: csvBuffer(rows).length,
    buffer: csvBuffer(rows),
  }) as Express.Multer.File;

describe('BulkImportService', () => {
  let prisma: {
    bulkImportBatch: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
    };
    bulkImportRow: {
      createMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    bulkImportImage: { groupBy: jest.Mock };
    business: { findMany: jest.Mock; create: jest.Mock };
    offer: { create: jest.Mock; update: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let storage: { uploadFile: jest.Mock };
  let service: BulkImportService;

  beforeEach(() => {
    prisma = {
      bulkImportBatch: {
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'batch-1', ...data }),
          ),
        findUnique: jest.fn(),
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'batch-1', ...data }),
          ),
        findMany: jest.fn().mockResolvedValue([]),
      },
      bulkImportRow: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn(),
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'row-1', ...data }),
          ),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      bulkImportImage: { groupBy: jest.fn().mockResolvedValue([]) },
      business: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
      offer: {
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest
        .fn()
        .mockImplementation((callback: (tx: unknown) => unknown) => {
          const tx = {
            business: prisma.business,
            offer: prisma.offer,
            bulkImportRow: prisma.bulkImportRow,
          };
          return callback(tx);
        }),
    };
    storage = {
      uploadFile: jest
        .fn()
        .mockResolvedValue('https://storage.example/bulk-import/offers.csv'),
    };
    service = new BulkImportService(prisma as any, storage as any);
  });

  describe('createBatch', () => {
    // Regression test: this used to assert the underlying FileImportError
    // propagated raw, which is what let it happen — FileImportError extends
    // plain Error, not HttpException, so an uncaught one reaches Nest's
    // default handler as an unhandled 500, not a 400. An admin dropping the
    // wrong file type (e.g. a PDF here) into the CSV/XLSX importer produced
    // a generic "Internal server error" toast instead of a clear rejection
    // message. Fixed by catching FileImportError in createBatch and
    // rethrowing as BadRequestException, matching the same pattern already
    // used for claim-evidence uploads (claim-request.service.ts).
    it('rejects an unrecognised file type as a BadRequestException, not a raw FileImportError, before touching storage', async () => {
      const badFile = {
        originalname: 'offers.pdf',
        mimetype: 'application/pdf',
        size: 10,
        buffer: Buffer.from('x'),
      } as Express.Multer.File;
      await expect(service.createBatch(badFile, 'admin-1')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.createBatch(badFile, 'admin-1')).rejects.toThrow(
        /Unsupported file type/,
      );
      expect(storage.uploadFile).not.toHaveBeenCalled();
    });

    it('creates a FAILED batch for a file with no data rows', async () => {
      const batch = await service.createBatch(csvFile([HEADERS]), 'admin-1');
      expect(batch.status).toBe('FAILED');
      expect(prisma.bulkImportRow.createMany).not.toHaveBeenCalled();
    });

    it('validates every row and persists correct aggregate counts', async () => {
      const batch = await service.createBatch(
        csvFile([HEADERS, VALID_ROW, INVALID_ROW]),
        'admin-1',
      );
      expect(batch.status).toBe('VALIDATED');
      expect(batch.total_rows).toBe(2);
      expect(batch.valid_rows).toBe(1);
      expect(batch.invalid_rows).toBe(1);
      expect(batch.duplicate_rows).toBe(0);

      const inserted = prisma.bulkImportRow.createMany.mock.calls[0][0].data;
      expect(inserted).toHaveLength(2);
      expect(inserted[0].status).toBe('VALID');
      expect(inserted[1].status).toBe('INVALID');
      expect(inserted[1].errors.length).toBeGreaterThan(0);
    });

    it('flags the second of two rows describing the same offer as DUPLICATE, not INVALID', async () => {
      const batch = await service.createBatch(
        csvFile([HEADERS, VALID_ROW, VALID_ROW]),
        'admin-1',
      );
      expect(batch.valid_rows).toBe(1);
      expect(batch.duplicate_rows).toBe(1);
      const inserted = prisma.bulkImportRow.createMany.mock.calls[0][0].data;
      expect(inserted[0].status).toBe('VALID');
      expect(inserted[1].status).toBe('DUPLICATE');
    });

    it('matches a row against an existing business by phone number', async () => {
      prisma.business.findMany.mockResolvedValue([
        { id: 'existing-biz', mobile: '9876543210' },
      ]);
      await service.createBatch(csvFile([HEADERS, VALID_ROW]), 'admin-1');
      const inserted = prisma.bulkImportRow.createMany.mock.calls[0][0].data;
      expect(inserted[0].matched_business_id).toBe('existing-biz');
    });

    it('leaves matched_business_id null when no existing business matches', async () => {
      await service.createBatch(csvFile([HEADERS, VALID_ROW]), 'admin-1');
      const inserted = prisma.bulkImportRow.createMany.mock.calls[0][0].data;
      expect(inserted[0].matched_business_id).toBeNull();
    });
  });

  describe('getBatchOffers', () => {
    const seedBatch = () =>
      prisma.bulkImportBatch.findUnique.mockResolvedValue({
        id: 'batch-1',
        status: 'CREATED',
      });

    it('splits the image outcomes an admin has to act on differently', async () => {
      seedBatch();
      prisma.bulkImportImage.groupBy.mockResolvedValue([
        { status: 'MAPPED', _count: { _all: 7 } },
        { status: 'MISSING_OFFER', _count: { _all: 2 } },
        { status: 'DUPLICATE', _count: { _all: 3 } },
        { status: 'INVALID_FILE', _count: { _all: 1 } },
      ]);
      const result = await service.getBatchOffers('batch-1');
      expect(result.imageStats).toEqual({
        uploaded: 13,
        matched: 7,
        missingOffer: 2,
        duplicate: 3,
        invalidFile: 1,
        failed: 0,
      });
    });

    // The reason offersWithoutImages is counted from the offers side: one
    // offer can hold many gallery images, so a "matched images" count never
    // tells you how many offers actually got covered.
    it('counts offers lacking a hero image rather than inferring it from image counts', async () => {
      seedBatch();
      prisma.bulkImportRow.findMany.mockResolvedValue([
        { row_no: 1, created_offer_id: 'o1' },
        { row_no: 2, created_offer_id: 'o2' },
        { row_no: 3, created_offer_id: 'o3' },
      ]);
      prisma.bulkImportImage.groupBy.mockResolvedValue([
        { status: 'MAPPED', _count: { _all: 6 } },
      ]);
      prisma.offer.findMany.mockResolvedValue([
        {
          id: 'o1',
          offer_code: 1,
          title: 'A',
          status: 'DRAFT',
          cover_image: 'https://s3/a.jpg',
          gallery_images: ['https://s3/a1.jpg', 'https://s3/a2.jpg'],
          business: { business_name: 'Shop A' },
        },
        {
          id: 'o2',
          offer_code: 2,
          title: 'B',
          status: 'DRAFT',
          cover_image: null,
          gallery_images: [],
          business: { business_name: 'Shop B' },
        },
        {
          id: 'o3',
          offer_code: 3,
          title: 'C',
          status: 'DRAFT',
          cover_image: null,
          gallery_images: [],
          business: null,
        },
      ]);

      const result = await service.getBatchOffers('batch-1');
      expect(result.offersWithoutImages).toBe(2);
      expect(result.offers).toHaveLength(3);
      expect(result.offers[0]).toEqual({
        id: 'o1',
        offer_code: 1,
        title: 'A',
        status: 'DRAFT',
        merchant: 'Shop A',
        cover_image: 'https://s3/a.jpg',
        gallery_images: ['https://s3/a1.jpg', 'https://s3/a2.jpg'],
      });
      expect(result.offers[2].merchant).toBeNull();
    });

    it('never queries offers when the batch created none', async () => {
      seedBatch();
      prisma.bulkImportRow.findMany.mockResolvedValue([]);
      const result = await service.getBatchOffers('batch-1');
      expect(prisma.offer.findMany).not.toHaveBeenCalled();
      expect(result.offers).toEqual([]);
      expect(result.offersWithoutImages).toBe(0);
    });

    it('rejects an unknown batch', async () => {
      prisma.bulkImportBatch.findUnique.mockResolvedValue(null);
      await expect(service.getBatchOffers('nope')).rejects.toThrow();
    });
  });

  describe('startCreatingDrafts', () => {
    it('rejects a batch that has not finished validating', async () => {
      prisma.bulkImportBatch.findUnique.mockResolvedValue({
        id: 'batch-1',
        status: 'QUEUED',
      });
      await expect(service.startCreatingDrafts('batch-1')).rejects.toThrow(
        /must be VALIDATED/,
      );
    });

    it('moves a VALIDATED batch to CREATING', async () => {
      prisma.bulkImportBatch.findUnique.mockResolvedValue({
        id: 'batch-1',
        status: 'VALIDATED',
      });
      const result = await service.startCreatingDrafts('batch-1');
      expect(result.status).toBe('CREATING');
    });
  });

  describe('createDraftForRow', () => {
    const normalized = {
      merchantName: 'Spec Gym',
      category: 'Fitness',
      title: '6 Month Pass',
      description: 'Great deal',
      offerType: 'STANDARD',
      originalPrice: 5000,
      offerPrice: 3000,
      requiredPeople: 1,
      startDate: new Date('2026-08-01'),
      endDate: new Date('2026-08-31'),
      mobile: '9876543210',
      whatsapp: null,
      email: null,
      website: null,
      address: '123 Main St',
      city: 'Bangalore',
      state: 'Karnataka',
      pincode: '560001',
      geoLat: null,
      geoLng: null,
      googleMapsLink: null,
      terms: null,
    };

    it('creates a new UNCLAIMED business when no match exists', async () => {
      prisma.bulkImportRow.findUnique.mockResolvedValue({
        id: 'row-1',
        batch_id: 'batch-1',
        status: 'VALID',
        normalized,
        matched_business_id: null,
      });
      prisma.business.create.mockResolvedValue({ id: 'new-biz' });
      prisma.offer.create.mockResolvedValue({ id: 'new-offer' });

      await service.createDraftForRow('row-1');

      expect(prisma.business.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            business_status: 'UNCLAIMED',
            source: 'ADMIN',
            mobile: '9876543210',
          }),
        }),
      );
      expect(prisma.offer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            business_id: 'new-biz',
            status: 'DRAFT',
          }),
        }),
      );
      expect(prisma.bulkImportRow.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'CREATED',
            created_offer_id: 'new-offer',
          }),
        }),
      );
    });

    it('increments the batch created_rows counter on success', async () => {
      prisma.bulkImportRow.findUnique.mockResolvedValue({
        id: 'row-1',
        batch_id: 'batch-1',
        status: 'VALID',
        normalized,
        matched_business_id: null,
      });
      prisma.business.create.mockResolvedValue({ id: 'new-biz' });
      prisma.offer.create.mockResolvedValue({ id: 'new-offer' });

      await service.createDraftForRow('row-1');

      expect(prisma.bulkImportBatch.update).toHaveBeenCalledWith({
        where: { id: 'batch-1' },
        data: { created_rows: { increment: 1 } },
      });
    });

    it('reuses an already-matched business instead of creating a new one', async () => {
      prisma.bulkImportRow.findUnique.mockResolvedValue({
        id: 'row-1',
        batch_id: 'batch-1',
        status: 'VALID',
        normalized,
        matched_business_id: 'existing-biz',
      });
      prisma.offer.create.mockResolvedValue({ id: 'new-offer' });

      await service.createDraftForRow('row-1');

      expect(prisma.business.create).not.toHaveBeenCalled();
      expect(prisma.offer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ business_id: 'existing-biz' }),
        }),
      );
    });

    it('marks the row FAILED rather than throwing when the transaction errors, without incrementing created_rows', async () => {
      prisma.bulkImportRow.findUnique.mockResolvedValue({
        id: 'row-1',
        batch_id: 'batch-1',
        status: 'VALID',
        normalized,
        matched_business_id: null,
      });
      prisma.business.create.mockRejectedValue(
        new Error('unique constraint violated'),
      );

      await expect(service.createDraftForRow('row-1')).resolves.toBeUndefined();
      expect(prisma.bulkImportRow.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'row-1' },
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
      expect(prisma.bulkImportBatch.update).not.toHaveBeenCalled();
    });

    it('does nothing for a row that is not VALID', async () => {
      prisma.bulkImportRow.findUnique.mockResolvedValue({
        id: 'row-1',
        batch_id: 'batch-1',
        status: 'INVALID',
        normalized: null,
      });
      await service.createDraftForRow('row-1');
      expect(prisma.business.create).not.toHaveBeenCalled();
      expect(prisma.offer.create).not.toHaveBeenCalled();
    });
  });

  describe('startPublishing', () => {
    it('rejects a batch whose offers are not fully created yet', async () => {
      prisma.bulkImportBatch.findUnique.mockResolvedValue({
        id: 'batch-1',
        status: 'CREATING',
      });
      await expect(service.startPublishing('batch-1')).rejects.toThrow(
        /must finish being created/,
      );
    });

    it('moves a CREATED batch to PUBLISHING', async () => {
      prisma.bulkImportBatch.findUnique.mockResolvedValue({
        id: 'batch-1',
        status: 'CREATED',
      });
      const result = await service.startPublishing('batch-1');
      expect(result.status).toBe('PUBLISHING');
    });
  });

  describe('publishRow', () => {
    it('flips the offer to ACTIVE and the row to PUBLISHED, incrementing published_rows', async () => {
      prisma.bulkImportRow.findUnique.mockResolvedValue({
        id: 'row-1',
        batch_id: 'batch-1',
        status: 'CREATED',
        created_offer_id: 'offer-1',
      });
      await service.publishRow('row-1');
      expect(prisma.offer.update).toHaveBeenCalledWith({
        where: { id: 'offer-1' },
        data: { status: 'ACTIVE' },
      });
      expect(prisma.bulkImportRow.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: { status: 'PUBLISHED' },
      });
      expect(prisma.bulkImportBatch.update).toHaveBeenCalledWith({
        where: { id: 'batch-1' },
        data: { published_rows: { increment: 1 } },
      });
    });

    it('marks the row FAILED rather than throwing when the update errors, without incrementing published_rows', async () => {
      prisma.bulkImportRow.findUnique.mockResolvedValue({
        id: 'row-1',
        batch_id: 'batch-1',
        status: 'CREATED',
        created_offer_id: 'offer-1',
      });
      prisma.offer.update.mockRejectedValue(new Error('db error'));

      await expect(service.publishRow('row-1')).resolves.toBeUndefined();
      expect(prisma.bulkImportRow.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
      expect(prisma.bulkImportBatch.update).not.toHaveBeenCalled();
    });

    it('does nothing for a row not yet CREATED', async () => {
      prisma.bulkImportRow.findUnique.mockResolvedValue({
        id: 'row-1',
        batch_id: 'batch-1',
        status: 'VALID',
        created_offer_id: null,
      });
      await service.publishRow('row-1');
      expect(prisma.offer.update).not.toHaveBeenCalled();
    });
  });
});
