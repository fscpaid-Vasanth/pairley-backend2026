import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BusinessService } from './business.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { FileValidationService } from '../discovery/file-validation.service';

// Module 12 Phase 1, Decision 4 — targeted regression test for the
// uploadDocuments() field-mapping bug found during the Module 12 STEP 1
// audit: aadhaar/pan file URLs were being written into aadhaar_number/
// pan_number (the text ID-number fields) instead of aadhaar_photo/
// pan_photo (the document-image fields). Deliberately scoped to just this
// method, not a full BusinessService test suite — matches Decision 4's
// "do not allow it to expand the scope" instruction.
//
// A real JPEG signature, not a fake buffer: uploadDocuments/uploadMedia now
// validate file content via FileValidationService (launch-audit finding —
// these two methods previously trusted the client-declared mimetype alone,
// unlike every other upload path in the app), so a fixture with fake bytes
// would fail validation before ever reaching the field-mapping logic these
// tests exist to cover.
describe('BusinessService.uploadDocuments (Decision 4 field-mapping fix)', () => {
  let businessFindUnique: jest.Mock;
  let businessUpdate: jest.Mock;
  let uploadFile: jest.Mock;
  let service: BusinessService;

  const existingBusiness = { id: 'business-1', business_name: 'Test Shop' };

  const REAL_JPEG_BYTES = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  ]);
  const NOT_A_JPEG_BYTES = Buffer.from('this is not an image');

  const multerFile = (name: string, buffer: Buffer = REAL_JPEG_BYTES) =>
    [
      {
        buffer,
        size: buffer.length,
        originalname: name,
        mimetype: 'image/jpeg',
      },
    ] as unknown as Express.Multer.File[];

  beforeEach(() => {
    businessFindUnique = jest.fn().mockResolvedValue(existingBusiness);
    businessUpdate = jest
      .fn()
      .mockImplementation(({ data }) =>
        Promise.resolve({ ...existingBusiness, ...data }),
      );
    uploadFile = jest
      .fn()
      .mockImplementation((file: Express.Multer.File, folder: string) =>
        Promise.resolve(
          `https://s3.example.com/${folder}/${file.originalname}`,
        ),
      );

    const prisma = {
      business: { findUnique: businessFindUnique, update: businessUpdate },
    };
    const storageService = { uploadFile };

    // Real instance, not a mock — same reasoning as
    // claim-request.service.spec.ts: FileValidationService is small, pure
    // and already covered on its own, so using the real thing here
    // exercises the actual magic-byte check against the fixtures above.
    service = new BusinessService(
      prisma as unknown as PrismaService,
      storageService as unknown as StorageService,
      {} as unknown as WhatsappService,
      new FileValidationService(),
    );
  });

  it('writes the uploaded aadhaar file URL to aadhaar_photo, not aadhaar_number', async () => {
    await service.uploadDocuments('business-1', {
      aadhaar: multerFile('aadhaar.jpg'),
    });
    expect(businessUpdate).toHaveBeenCalledWith({
      where: { id: 'business-1' },
      data: { aadhaar_photo: 'https://s3.example.com/documents/aadhaar.jpg' },
    });
  });

  it('writes the uploaded PAN file URL to pan_photo, not pan_number', async () => {
    await service.uploadDocuments('business-1', { pan: multerFile('pan.jpg') });
    expect(businessUpdate).toHaveBeenCalledWith({
      where: { id: 'business-1' },
      data: { pan_photo: 'https://s3.example.com/documents/pan.jpg' },
    });
  });

  it('still writes shop_photo correctly — unaffected by this fix', async () => {
    await service.uploadDocuments('business-1', {
      shop_photo: multerFile('shop.jpg'),
    });
    expect(businessUpdate).toHaveBeenCalledWith({
      where: { id: 'business-1' },
      data: { shop_photo: 'https://s3.example.com/shops/shop.jpg' },
    });
  });

  it('handles all four document types together in one call', async () => {
    await service.uploadDocuments('business-1', {
      shop_photo: multerFile('shop.jpg'),
      aadhaar: multerFile('aadhaar.jpg'),
      pan: multerFile('pan.jpg'),
      gst: multerFile('gst.jpg'),
    });
    expect(businessUpdate).toHaveBeenCalledWith({
      where: { id: 'business-1' },
      data: {
        shop_photo: 'https://s3.example.com/shops/shop.jpg',
        aadhaar_photo: 'https://s3.example.com/documents/aadhaar.jpg',
        pan_photo: 'https://s3.example.com/documents/pan.jpg',
        // gst was not part of Decision 4's fix — no gst_photo field exists
        // on Business, so this remains as it was before Module 12.
        gst_number: 'https://s3.example.com/documents/gst.jpg',
      },
    });
  });

  it('throws NotFound for a nonexistent business', async () => {
    businessFindUnique.mockResolvedValue(null);
    await expect(
      service.uploadDocuments('missing', {
        shop_photo: multerFile('shop.jpg'),
      }),
    ).rejects.toThrow(NotFoundException);
  });

  // Launch-audit finding: uploadDocuments trusted the client-declared
  // mimetype alone. A file whose actual bytes don't match a real image —
  // renamed, mislabeled, or deliberately spoofed — must now be rejected
  // rather than handed straight to storage.
  describe('file content validation (launch-audit fix)', () => {
    it('rejects a KYC document whose content does not match its declared image mimetype', async () => {
      await expect(
        service.uploadDocuments('business-1', {
          aadhaar: multerFile('aadhaar.jpg', NOT_A_JPEG_BYTES),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(uploadFile).not.toHaveBeenCalled();
    });

    it('rejects the whole batch — uploads nothing — if any one file in it fails validation', async () => {
      // Reject-before-processing: shop_photo is a real, valid image here,
      // but pan is not — nothing should upload, not even the valid file.
      await expect(
        service.uploadDocuments('business-1', {
          shop_photo: multerFile('shop.jpg'),
          pan: multerFile('pan.jpg', NOT_A_JPEG_BYTES),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(uploadFile).not.toHaveBeenCalled();
    });

    it('still uploads normally when every file is a genuine image', async () => {
      await expect(
        service.uploadDocuments('business-1', {
          aadhaar: multerFile('aadhaar.jpg'),
        }),
      ).resolves.toBeDefined();
      expect(uploadFile).toHaveBeenCalledTimes(1);
    });
  });
});

// Same fix, same discipline, for the merchant-media path (logo/cover/
// gallery) — a separate describe block since uploadMedia has its own
// existing behaviour (accumulating gallery images) worth keeping distinct
// from uploadDocuments' field-mapping-focused suite above.
describe('BusinessService.uploadMedia (launch-audit file validation fix)', () => {
  let businessFindUnique: jest.Mock;
  let businessUpdate: jest.Mock;
  let uploadFile: jest.Mock;
  let service: BusinessService;

  const existingBusiness = {
    id: 'business-1',
    business_name: 'Test Shop',
    gallery_images: [] as string[],
  };

  const REAL_JPEG_BYTES = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  ]);
  const NOT_A_JPEG_BYTES = Buffer.from('this is not an image');

  const multerFile = (name: string, buffer: Buffer = REAL_JPEG_BYTES) =>
    [
      {
        buffer,
        size: buffer.length,
        originalname: name,
        mimetype: 'image/jpeg',
      },
    ] as unknown as Express.Multer.File[];

  beforeEach(() => {
    businessFindUnique = jest.fn().mockResolvedValue(existingBusiness);
    businessUpdate = jest
      .fn()
      .mockImplementation(({ data }) =>
        Promise.resolve({ ...existingBusiness, ...data }),
      );
    uploadFile = jest
      .fn()
      .mockImplementation((file: Express.Multer.File, folder: string) =>
        Promise.resolve(
          `https://s3.example.com/${folder}/${file.originalname}`,
        ),
      );

    const prisma = {
      business: { findUnique: businessFindUnique, update: businessUpdate },
    };
    const storageService = { uploadFile };

    service = new BusinessService(
      prisma as unknown as PrismaService,
      storageService as unknown as StorageService,
      {} as unknown as WhatsappService,
      new FileValidationService(),
    );
  });

  it('rejects a spoofed logo file before uploading anything', async () => {
    await expect(
      service.uploadMedia('business-1', {
        logo: multerFile('logo.jpg', NOT_A_JPEG_BYTES),
      }),
    ).rejects.toThrow(BadRequestException);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('rejects the batch if even one gallery image fails validation', async () => {
    await expect(
      service.uploadMedia('business-1', {
        gallery: [
          ...multerFile('good.jpg'),
          ...multerFile('bad.jpg', NOT_A_JPEG_BYTES),
        ],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('uploads normally when logo, cover image and gallery are all genuine images', async () => {
    const result = await service.uploadMedia('business-1', {
      logo: multerFile('logo.jpg'),
      cover_image: multerFile('cover.jpg'),
      gallery: multerFile('gallery-1.jpg'),
    });
    expect(uploadFile).toHaveBeenCalledTimes(3);
    expect(result.logo).toBe('https://s3.example.com/businesses/logo/logo.jpg');
  });
});
