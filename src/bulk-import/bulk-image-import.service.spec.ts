import { BulkImageImportService } from './bulk-image-import.service';

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const NOT_AN_IMAGE = Buffer.from('this is not an image');

function jpegFile(name: string, buffer = JPEG_BYTES): Express.Multer.File {
  return {
    originalname: name,
    mimetype: 'image/jpeg',
    size: buffer.length,
    buffer,
  } as Express.Multer.File;
}

describe('BulkImageImportService', () => {
  let prisma: {
    bulkImportBatch: { findUnique: jest.Mock; update: jest.Mock };
    bulkImportRow: { findMany: jest.Mock };
    bulkImportImage: { findMany: jest.Mock; create: jest.Mock };
    offer: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  };
  let storage: { uploadFile: jest.Mock };
  let fileValidation: { validate: jest.Mock; sanitizeFilename: jest.Mock };
  let service: BulkImageImportService;

  beforeEach(() => {
    prisma = {
      bulkImportBatch: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'batch-1', status: 'CREATED' }),
        update: jest.fn().mockResolvedValue({}),
      },
      bulkImportRow: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ created_offer_id: 'offer-a' }]),
      },
      bulkImportImage: {
        findMany: jest.fn().mockResolvedValue([]), // no pre-existing mapped slots
        create: jest.fn().mockResolvedValue({}),
      },
      offer: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'offer-a', offer_code: 123 }]),
        findUnique: jest.fn().mockResolvedValue({ gallery_images: [] }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    storage = {
      uploadFile: jest
        .fn()
        .mockResolvedValue('https://storage.example/img.jpg'),
    };
    fileValidation = {
      validate: jest.fn(),
      sanitizeFilename: jest.fn((name: string) => name),
    };
    service = new BulkImageImportService(
      prisma as any,
      storage as any,
      fileValidation,
    );
  });

  it('rejects uploading images before offers have been created', async () => {
    prisma.bulkImportBatch.findUnique.mockResolvedValue({
      id: 'batch-1',
      status: 'VALIDATED',
    });
    await expect(
      service.uploadImageFiles('batch-1', [jpegFile('OFF000123.jpg')]),
    ).rejects.toThrow(/Cannot upload images/);
  });

  it('maps a hero image (no suffix) to Offer.cover_image', async () => {
    await service.uploadImageFiles('batch-1', [jpegFile('OFF000123.jpg')]);
    expect(prisma.offer.update).toHaveBeenCalledWith({
      where: { id: 'offer-a' },
      data: { cover_image: 'https://storage.example/img.jpg' },
    });
    expect(prisma.bulkImportImage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'MAPPED', slot: 0 }),
      }),
    );
  });

  it('appends a gallery image (_N suffix) to Offer.gallery_images', async () => {
    prisma.offer.findUnique.mockResolvedValue({
      gallery_images: ['https://existing.jpg'],
    });
    await service.uploadImageFiles('batch-1', [jpegFile('OFF000123_2.jpg')]);
    expect(prisma.offer.update).toHaveBeenCalledWith({
      where: { id: 'offer-a' },
      data: {
        gallery_images: [
          'https://existing.jpg',
          'https://storage.example/img.jpg',
        ],
      },
    });
  });

  it('records MISSING_OFFER for a code with no matching offer, without touching storage', async () => {
    await service.uploadImageFiles('batch-1', [jpegFile('OFF000999.jpg')]);
    expect(storage.uploadFile).not.toHaveBeenCalled();
    expect(prisma.bulkImportImage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'MISSING_OFFER' }),
      }),
    );
    expect(prisma.bulkImportBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failed_images: { increment: 1 } }),
      }),
    );
  });

  it('rejects a file whose bytes are not actually an image, even though the filename matches', async () => {
    fileValidation.validate.mockImplementation(() => {
      throw new Error('File content does not match any supported format');
    });
    await service.uploadImageFiles('batch-1', [
      jpegFile('OFF000123.jpg', NOT_AN_IMAGE),
    ]);
    expect(storage.uploadFile).not.toHaveBeenCalled();
    expect(prisma.bulkImportImage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
  });

  it('marks the second file for an already-mapped slot as DUPLICATE within one upload', async () => {
    await service.uploadImageFiles('batch-1', [
      jpegFile('OFF000123.jpg'),
      jpegFile('OFF000123.jpg'), // same code, same (default hero) slot
    ]);
    expect(storage.uploadFile).toHaveBeenCalledTimes(1);
    const statuses = prisma.bulkImportImage.create.mock.calls.map(
      (c) => c[0].data.status,
    );
    expect(statuses).toEqual(['MAPPED', 'DUPLICATE']);
  });

  it('treats a pre-existing MAPPED slot from an earlier upload call as taken', async () => {
    prisma.bulkImportImage.findMany.mockResolvedValue([
      { matched_offer_id: 'offer-a', slot: 0 },
    ]);
    await service.uploadImageFiles('batch-1', [jpegFile('OFF000123.jpg')]);
    expect(storage.uploadFile).not.toHaveBeenCalled();
    expect(prisma.bulkImportImage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DUPLICATE' }),
      }),
    );
  });

  // The bug this guards: reserving a slot before the upload attempt
  // succeeds would incorrectly block a later, valid retry for that same
  // slot within the same upload call.
  it('does not block a subsequent valid file for a slot whose first attempt failed', async () => {
    fileValidation.validate
      .mockImplementationOnce(() => {
        throw new Error('corrupt file');
      })
      .mockImplementationOnce(() => undefined);

    await service.uploadImageFiles('batch-1', [
      jpegFile('OFF000123.jpg'), // fails validation
      jpegFile('OFF000123.jpg'), // should still be allowed to fill the slot
    ]);

    const statuses = prisma.bulkImportImage.create.mock.calls.map(
      (c) => c[0].data.status,
    );
    expect(statuses).toEqual(['FAILED', 'MAPPED']);
    expect(storage.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('rejects a file whose declared mimetype is PDF even if it otherwise matches', async () => {
    const file = {
      originalname: 'OFF000123.jpg',
      mimetype: 'application/pdf',
      size: 10,
      buffer: Buffer.from('%PDF-1.4'),
    } as Express.Multer.File;
    await service.uploadImageFiles('batch-1', [file]);
    expect(storage.uploadFile).not.toHaveBeenCalled();
    expect(prisma.bulkImportImage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
  });

  it('never matches a code that only exists in a different batch', async () => {
    prisma.bulkImportRow.findMany.mockResolvedValue([]); // this batch created nothing
    prisma.offer.findMany.mockResolvedValue([]);
    await service.uploadImageFiles('batch-1', [jpegFile('OFF000123.jpg')]);
    expect(storage.uploadFile).not.toHaveBeenCalled();
    expect(prisma.bulkImportImage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'MISSING_OFFER' }),
      }),
    );
  });
});
