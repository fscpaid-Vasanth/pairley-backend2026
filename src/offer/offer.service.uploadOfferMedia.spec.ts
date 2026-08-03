import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OfferService } from './offer.service';
import { FileValidationService } from '../discovery/file-validation.service';

// Launch-readiness audit finding: uploadOfferMedia trusted the client-
// declared mimetype alone before handing cover/gallery images straight to
// storage — the one offer-image upload path (CreateDealPage.jsx calls this
// directly) that didn't already validate actual file content, unlike the
// Offer Publisher tool and merchant KYC uploads (see business.service.spec's
// equivalent tests). A real JPEG signature vs. a spoofed one is the same
// fixture pattern used there.
describe('OfferService.uploadOfferMedia — file content validation', () => {
  const REAL_JPEG_BYTES = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  ]);
  const NOT_A_JPEG_BYTES = Buffer.from('this is not an image, just text');

  const multerFile = (buffer: Buffer, mimetype = 'image/jpeg') => ({
    buffer,
    mimetype,
    size: buffer.length,
    originalname: 'photo.jpg',
  });

  const makePrisma = (offer: any) => ({
    offer: {
      findUnique: jest.fn().mockResolvedValue(offer),
      update: jest.fn().mockResolvedValue({}),
    },
  });

  const makeStorageService = () => ({
    uploadFile: jest.fn().mockResolvedValue('https://storage.example.com/offers/cover/photo.jpg'),
  });

  // Real instance — pure, dependency-free, and this is exactly the class
  // under test's own genuine magic-byte check, not a stub of it.
  const fileValidationService = new FileValidationService();

  const makeService = (prisma: any, storageService: any) =>
    new OfferService(
      prisma as any,
      {} as any, // NotificationService — unused
      {} as any, // OtpService — unused
      storageService as any,
      {} as any, // WhatsappService — unused
      { get: jest.fn() } as any, // ConfigService — unused
      {} as any, // CategoryService — unused
      fileValidationService,
    );

  const offer = {
    id: 'offer-1',
    business_id: 'biz-1',
    gallery_images: [],
  };

  it('rejects a spoofed cover_image (wrong mimetype declared, real content is not a JPEG)', async () => {
    const prisma = makePrisma(offer);
    const storageService = makeStorageService();
    const service = makeService(prisma, storageService);

    await expect(
      service.uploadOfferMedia('biz-1', 'offer-1', {
        cover_image: [multerFile(NOT_A_JPEG_BYTES) as any],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(storageService.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects a batch where one gallery image is spoofed, uploading none of them', async () => {
    const prisma = makePrisma(offer);
    const storageService = makeStorageService();
    const service = makeService(prisma, storageService);

    await expect(
      service.uploadOfferMedia('biz-1', 'offer-1', {
        gallery: [
          multerFile(REAL_JPEG_BYTES) as any,
          multerFile(NOT_A_JPEG_BYTES) as any,
        ],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(storageService.uploadFile).not.toHaveBeenCalled();
  });

  it('uploads normally when cover_image and gallery are all genuine', async () => {
    const prisma = makePrisma(offer);
    const storageService = makeStorageService();
    const service = makeService(prisma, storageService);

    await service.uploadOfferMedia('biz-1', 'offer-1', {
      cover_image: [multerFile(REAL_JPEG_BYTES) as any],
      gallery: [multerFile(REAL_JPEG_BYTES) as any],
    });

    expect(storageService.uploadFile).toHaveBeenCalledTimes(2);
    expect(prisma.offer.update).toHaveBeenCalled();
  });

  it('still enforces ownership before any validation runs', async () => {
    const prisma = makePrisma({ ...offer, business_id: 'someone-else' });
    const storageService = makeStorageService();
    const service = makeService(prisma, storageService);

    await expect(
      service.uploadOfferMedia('biz-1', 'offer-1', {
        cover_image: [multerFile(REAL_JPEG_BYTES) as any],
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(storageService.uploadFile).not.toHaveBeenCalled();
  });
});
