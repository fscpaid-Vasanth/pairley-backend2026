import { NotFoundException } from '@nestjs/common';
import { BusinessService } from './business.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

// Module 12 Phase 1, Decision 4 — targeted regression test for the
// uploadDocuments() field-mapping bug found during the Module 12 STEP 1
// audit: aadhaar/pan file URLs were being written into aadhaar_number/
// pan_number (the text ID-number fields) instead of aadhaar_photo/
// pan_photo (the document-image fields). Deliberately scoped to just this
// method, not a full BusinessService test suite — matches Decision 4's
// "do not allow it to expand the scope" instruction.
describe('BusinessService.uploadDocuments (Decision 4 field-mapping fix)', () => {
  let businessFindUnique: jest.Mock;
  let businessUpdate: jest.Mock;
  let uploadFile: jest.Mock;
  let service: BusinessService;

  const existingBusiness = { id: 'business-1', business_name: 'Test Shop' };

  const multerFile = (name: string) =>
    [
      {
        buffer: Buffer.from('fake'),
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
});
