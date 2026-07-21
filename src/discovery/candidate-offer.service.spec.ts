import {
  BusinessStatus,
  OfferStatus,
  OfferType,
  Source,
  VerificationStatus,
} from '@prisma/client';
import { CandidateOfferService } from './candidate-offer.service';
import { PrismaService } from '../prisma/prisma.service';

describe('CandidateOfferService', () => {
  let businessCreate: jest.Mock;
  let offerCreate: jest.Mock;
  let offerVersionCreate: jest.Mock;
  let prisma: { $transaction: jest.Mock };
  let service: CandidateOfferService;

  beforeEach(() => {
    businessCreate = jest
      .fn()
      .mockImplementation(({ data }) =>
        Promise.resolve({ id: 'business-1', ...data }),
      );
    offerCreate = jest
      .fn()
      .mockImplementation(({ data }) =>
        Promise.resolve({ id: 'offer-1', ...data }),
      );
    offerVersionCreate = jest.fn().mockResolvedValue({ id: 'version-1' });

    const tx = {
      business: { create: businessCreate },
      offer: { create: offerCreate },
      offerVersion: { create: offerVersionCreate },
    };
    prisma = {
      $transaction: jest
        .fn()
        .mockImplementation((callback: (tx: unknown) => unknown) =>
          callback(tx),
        ),
    };

    service = new CandidateOfferService(prisma as unknown as PrismaService);
  });

  it('creates an UNCLAIMED business and a DRAFT, review-required offer from a full extraction', async () => {
    const result = await service.createCandidate({
      sourceUrl: 'https://real-shop.example.com/diwali-sale',
      fields: {
        title: 'Diwali Sale',
        description: '20% off everything',
        image: 'https://x/img.jpg',
        price: 1500,
      },
      confidence: 0.9,
    });

    const businessData = {
      data: expect.objectContaining({
        business_status: BusinessStatus.UNCLAIMED,
        source: Source.WEBSITE,
        created_by_ai: true,
        mobile: null,
        business_name: 'real-shop.example.com (imported)',
        verification_status: VerificationStatus.PENDING,
      }) as unknown,
    };
    expect(businessCreate).toHaveBeenCalledWith(businessData);

    const offerData = {
      data: expect.objectContaining({
        business_id: 'business-1',
        title: 'Diwali Sale',
        description: '20% off everything',
        original_price: 1500,
        offer_price: 1500,
        status: OfferStatus.DRAFT,
        review_required: true,
        source: Source.WEBSITE,
        offer_type: OfferType.STANDARD,
        confidence_score: 0.9,
        original_import_url: 'https://real-shop.example.com/diwali-sale',
        cover_image: 'https://x/img.jpg',
      }) as unknown,
    };
    expect(offerCreate).toHaveBeenCalledWith(offerData);

    const versionData = {
      data: expect.objectContaining({
        offer_id: 'offer-1',
        change_type: 'AI_IMPORT',
        changed_by: null,
      }) as unknown,
    };
    expect(offerVersionCreate).toHaveBeenCalledWith(versionData);

    expect(result.warnings).toEqual([
      'Category not detected — defaulted to "Shopping", please verify',
    ]);
    expect(result.business.id).toBe('business-1');
    expect(result.offer.id).toBe('offer-1');
  });

  it('fills in placeholders and reports warnings for a sparse extraction', async () => {
    const result = await service.createCandidate({
      sourceUrl: 'https://example.com/',
      fields: { title: null, description: null, image: null, price: null },
      confidence: 0,
    });

    const offerData = {
      data: expect.objectContaining({
        title: 'Untitled Imported Offer',
        description: 'No description available.',
        original_price: 0,
        offer_price: 0,
        cover_image: null,
      }) as unknown,
    };
    expect(offerCreate).toHaveBeenCalledWith(offerData);

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'No title detected — using a placeholder',
        'No description detected',
        'No price detected — defaulted to ₹0',
        'No image detected',
        'Category not detected — defaulted to "Shopping", please verify',
      ]),
    );
  });

  it('falls back to a generic business name when the source URL cannot be parsed', async () => {
    await service.createCandidate({
      sourceUrl: 'not-a-real-url',
      fields: { title: 'X', description: null, image: null, price: null },
      confidence: 0.4,
    });
    const businessData = {
      data: expect.objectContaining({
        business_name: 'Imported Business (unknown source)',
      }) as unknown,
    };
    expect(businessCreate).toHaveBeenCalledWith(businessData);
  });
});
