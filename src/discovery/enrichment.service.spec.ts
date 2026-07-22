import { EnrichmentStatus, OfferType } from '@prisma/client';
import { EnrichmentService } from './enrichment.service';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentResult } from './enrichment-provider';

function fakeResult(
  overrides: Partial<EnrichmentResult> = {},
): EnrichmentResult {
  return {
    category: {
      suggested: 'dining',
      original: 'shopping',
      confidence: 0.75,
      rationale: 'matched',
    },
    offerType: {
      suggested: OfferType.STANDARD,
      original: OfferType.STANDARD,
      confidence: 0.25,
      rationale: 'no match',
    },
    merchantType: {
      suggested: 'Restaurant / Food Service',
      original: null,
      confidence: 0.75,
      rationale: 'matched',
    },
    tags: {
      suggested: ['diwali', 'sale'],
      original: [],
      confidence: 1,
      rationale: 'extracted',
    },
    keywords: {
      suggested: ['diwali', 'sale', 'dining'],
      original: [],
      confidence: 1,
      rationale: 'extracted',
    },
    ...overrides,
  };
}

const offer = {
  id: 'offer-1',
  title: 'Diwali Mega Sale',
  description: 'Flat 40% off',
  category: 'shopping',
  offer_type: OfferType.STANDARD,
} as never;

const business = { id: 'business-1' } as never;

describe('EnrichmentService', () => {
  let provider: { enrich: jest.Mock };
  let offerUpdate: jest.Mock;
  let businessUpdate: jest.Mock;
  let service: EnrichmentService;

  beforeEach(() => {
    provider = { enrich: jest.fn().mockResolvedValue(fakeResult()) };
    offerUpdate = jest.fn().mockResolvedValue({});
    businessUpdate = jest.fn().mockResolvedValue({});
    const prisma = {
      offer: { update: offerUpdate },
      business: { update: businessUpdate },
    };
    service = new EnrichmentService(
      provider,
      prisma as unknown as PrismaService,
    );
  });

  it('persists tags, keywords, enrichment status/confidence, and the full metadata trail on the offer', async () => {
    await service.enrichAndPersist(offer, business);

    expect(offerUpdate).toHaveBeenCalledWith({
      where: { id: 'offer-1' },
      data: expect.objectContaining({
        tags: ['diwali', 'sale'],
        keywords: ['diwali', 'sale', 'dining'],
        enrichment_status: EnrichmentStatus.ENRICHED,
        enrichment_metadata: fakeResult(),
      }) as unknown,
    });
  });

  it('does not touch category, offer_type, or business_type — only the dedicated enrichment fields', async () => {
    await service.enrichAndPersist(offer, business);

    // Exact equality (not objectContaining) — proves category/offer_type
    // are absent from the write, not just that the expected keys are present.
    expect(offerUpdate).toHaveBeenCalledWith({
      where: { id: 'offer-1' },
      data: {
        tags: ['diwali', 'sale'],
        keywords: ['diwali', 'sale', 'dining'],
        enrichment_status: EnrichmentStatus.ENRICHED,
        enrichment_confidence: 0.75,
        enrichment_metadata: fakeResult(),
      },
    });
    expect(businessUpdate).toHaveBeenCalledWith({
      where: { id: 'business-1' },
      data: { suggested_merchant_type: 'Restaurant / Food Service' },
    });
  });

  it('averages the five per-field confidences into a single overall enrichment_confidence', async () => {
    await service.enrichAndPersist(offer, business);
    // (0.75 + 0.25 + 0.75 + 1 + 1) / 5 = 0.75
    expect(offerUpdate).toHaveBeenCalledWith({
      where: { id: 'offer-1' },
      data: expect.objectContaining({ enrichment_confidence: 0.75 }) as unknown,
    });
  });

  it('calls the injected provider with the offer title/description/category/offer_type, not raw import text', async () => {
    await service.enrichAndPersist(offer, business);
    expect(provider.enrich).toHaveBeenCalledWith({
      title: 'Diwali Mega Sale',
      description: 'Flat 40% off',
      currentCategory: 'shopping',
      currentOfferType: OfferType.STANDARD,
    });
  });

  it('marks the offer ENRICHMENT_FAILED and never throws when the provider errors', async () => {
    provider.enrich.mockRejectedValue(new Error('provider exploded'));

    await expect(
      service.enrichAndPersist(offer, business),
    ).resolves.toBeUndefined();

    expect(offerUpdate).toHaveBeenCalledWith({
      where: { id: 'offer-1' },
      data: { enrichment_status: EnrichmentStatus.ENRICHMENT_FAILED },
    });
    expect(businessUpdate).not.toHaveBeenCalled();
  });

  it('never throws even if the failure-status write itself fails', async () => {
    provider.enrich.mockRejectedValue(new Error('provider exploded'));
    offerUpdate.mockRejectedValue(new Error('db also down'));

    await expect(
      service.enrichAndPersist(offer, business),
    ).resolves.toBeUndefined();
  });
});
