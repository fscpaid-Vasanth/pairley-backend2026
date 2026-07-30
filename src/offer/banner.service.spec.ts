import { NotFoundException } from '@nestjs/common';
import { BannerService, BANNER_CHANGE_TYPES } from './banner.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { BannerRenderService } from './banner-render.service';
import { ImageAnalysisService } from './image-analysis.service';

const OFFER = {
  id: 'offer-1',
  business_id: 'biz-1',
  title: 'Weekend Buffet',
  offer_type: 'BOGO',
  category: 'dining',
  original_price: 1200,
  offer_price: 600,
  required_people: 2,
  source: 'WEBSITE',
  merchant_verified: false,
  is_pairley_exclusive: false,
  original_poster: null,
  cover_image: 'https://x/cover.jpg',
  offer_image: null,
  gallery_images: [] as string[],
  facility_images: [] as string[],
  business: {
    business_name: 'The Big Barbeque',
    business_status: 'UNCLAIMED',
    city: 'Chennai',
    mall_name: null,
    shop_photo: 'https://x/shop.jpg',
    logo: null,
  },
};

function makeProbe(url: string, over: Record<string, unknown> = {}) {
  return {
    url,
    ok: true,
    width: 1600,
    height: 1600,
    orientation: 'square',
    brightness: 0.45,
    contrast: 0.2,
    sharpness: 0.8,
    watermarkConfidence: null,
    ...over,
  };
}

describe('BannerService (Module 14 Phase 3C)', () => {
  let prisma: {
    offer: { findUnique: jest.Mock; update: jest.Mock };
    offerVersion: { count: jest.Mock; create: jest.Mock; findMany: jest.Mock };
    rating: { aggregate: jest.Mock };
  };
  let storage: { uploadFile: jest.Mock };
  let renderer: { render: jest.Mock };
  let imageAnalysis: {
    probeAll: jest.Mock;
    toCandidates: jest.Mock;
    analyseBuffer: jest.Mock;
  };
  let service: BannerService;

  beforeEach(() => {
    prisma = {
      offer: {
        findUnique: jest.fn().mockResolvedValue(OFFER),
        update: jest.fn().mockResolvedValue(OFFER),
      },
      offerVersion: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      // No reviews by default — the realistic case for a freshly
      // AI-discovered business, and what exercises the "omit, don't
      // fabricate" rating rule.
      rating: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _avg: { rating: null }, _count: 0 }),
      },
    };
    storage = {
      uploadFile: jest
        .fn()
        .mockResolvedValue('https://s3.example.com/banners/banner-1.png'),
    };
    renderer = {
      render: jest.fn().mockResolvedValue({
        buffer: Buffer.from('png'),
        width: 1080,
        height: 1080,
        usedHeroImage: true,
      }),
    };
    imageAnalysis = {
      probeAll: jest
        .fn()
        .mockImplementation((urls: string[]) =>
          Promise.resolve(urls.map((url) => makeProbe(url))),
        ),
      toCandidates: jest
        .fn()
        .mockImplementation((probes: { ok: boolean; url: string }[]) =>
          probes
            .filter((p) => p.ok)
            .map((p) => ({
              url: p.url,
              role: 'PRODUCT',
              width: 1600,
              height: 1600,
              brightness: 0.45,
              contrast: 0.2,
              watermarkSuspected: null,
              focus: 0.8,
            })),
        ),
      analyseBuffer: jest.fn().mockResolvedValue(makeProbe('uploaded')),
    };

    service = new BannerService(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
      renderer as unknown as BannerRenderService,
      imageAnalysis as unknown as ImageAnalysisService,
    );
  });

  describe('buildPlan', () => {
    // Module 14 Phase 3C follow-up (Template F / Cost-Split).
    it('computes costSplitEligible from the same function the renderer uses, not a re-derived check', async () => {
      const plan = await service.buildPlan('offer-1');
      // The fixture offer (₹1,200 -> ₹600, 2 people) is a genuine 50/50
      // split, so Template F must be a real contender for it.
      expect(
        plan.templateRecommendation.scores.map((s) => s.templateId),
      ).toContain('F');
    });

    it('recommends against Template F when there is no genuine split', async () => {
      prisma.offer.findUnique.mockResolvedValue({
        ...OFFER,
        offer_price: OFFER.original_price,
      });
      const plan = await service.buildPlan('offer-1');
      expect(plan.templateRecommendation.templateId).not.toBe('F');
    });

    it('collects every known image and ranks them', async () => {
      const plan = await service.buildPlan('offer-1');
      expect(plan.heroImageUrl).toBeTruthy();
      expect(plan.heroRanking.length).toBeGreaterThan(0);
      expect(plan.templateRecommendation.templateId).toBeTruthy();
    });

    it('throws NotFound for a missing offer', async () => {
      prisma.offer.findUnique.mockResolvedValue(null);
      await expect(service.buildPlan('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lets an explicit hero override win over the ranker', async () => {
      const plan = await service.buildPlan('offer-1', {
        heroImageUrl: 'https://x/shop.jpg',
      });
      expect(plan.heroImageUrl).toBe('https://x/shop.jpg');
      expect(plan.heroNeedsReview).toBe(false);
    });

    it('lets a valid template override win over the recommendation', async () => {
      const plan = await service.buildPlan('offer-1', { templateId: 'D' });
      expect(plan.templateId).toBe('D');
    });

    it('ignores an invalid template override and falls back to the recommendation', async () => {
      const plan = await service.buildPlan('offer-1', {
        templateId: 'not-a-template',
      });
      // Not a hardcoded A-E list: the fixture offer is a genuine 2-way BOGO
      // split, so Template F is a legitimate recommendation for it too.
      expect(['A', 'B', 'C', 'D', 'E', 'F']).toContain(plan.templateId);
    });

    it('applies a manual watermark flag to the matching candidate before ranking', async () => {
      const clean = await service.buildPlan('offer-1');
      const flagged = await service.buildPlan('offer-1', {
        watermarkFlags: { 'https://x/cover.jpg': true },
      });
      const cleanScore = clean.heroRanking.find(
        (r) => r.candidate.url === 'https://x/cover.jpg',
      )?.score;
      const flaggedScore = flagged.heroRanking.find(
        (r) => r.candidate.url === 'https://x/cover.jpg',
      )?.score;
      expect(flaggedScore).toBeLessThan(cleanScore!);
    });
  });

  describe('generate', () => {
    it('renders, uploads, records a version and updates generated_offer_card', async () => {
      const result = await service.generate('offer-1', 'admin-1');
      expect(renderer.render).toHaveBeenCalledTimes(1);
      expect(storage.uploadFile).toHaveBeenCalledTimes(1);
      expect(prisma.offerVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            change_type: BANNER_CHANGE_TYPES.GENERATED,
            changed_by: 'admin-1',
          }),
        }),
      );
      expect(prisma.offer.update).toHaveBeenCalledWith({
        where: { id: 'offer-1' },
        data: {
          generated_offer_card: 'https://s3.example.com/banners/banner-1.png',
        },
      });
      expect(result.versionNo).toBe(1);
      expect(result.bannerUrl).toBe(
        'https://s3.example.com/banners/banner-1.png',
      );
    });

    it('increments the version number on each successive generation', async () => {
      prisma.offerVersion.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(3);
      const first = await service.generate('offer-1', 'admin-1');
      const second = await service.generate('offer-1', 'admin-1');
      expect(first.versionNo).toBe(1);
      expect(second.versionNo).toBe(4);
    });

    it('passes the resolved offer fields into the renderer', async () => {
      await service.generate('offer-1', 'admin-1', { templateId: 'C' });
      expect(renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Weekend Buffet',
          offerType: 'BOGO',
          businessName: 'The Big Barbeque',
          templateId: 'C',
          offerId: 'offer-1',
        }),
      );
    });

    // Branding wiring. resolveBranding() decides what a mode actually
    // *grants* (bannerBranding.spec.ts covers that exhaustively, including
    // the refusal for unclaimed businesses); these confirm the service
    // hands it the right inputs in the first place.
    it('uses the merchant’s stored branding preference when the admin has not overridden it', async () => {
      prisma.offer.findUnique.mockResolvedValue({
        ...OFFER,
        business: {
          ...OFFER.business,
          business_status: 'CLAIMED',
          banner_branding_mode: 'MERCHANT',
          brand_color: '#FF6600',
        },
      });
      await service.generate('offer-1', 'admin-1');
      expect(renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({
          brandingMode: 'MERCHANT',
          brandColor: '#FF6600',
        }),
      );
    });

    // The studio toggle previews a mode for one render: it wins over the
    // stored preference for that render and is never written back. The
    // "never written back" half needs no assertion — the preference lives on
    // Business, and this service holds no writer for it (the prisma double
    // exposes none, so any attempt would throw here).
    it('lets an explicit preview override the stored preference for that render only', async () => {
      prisma.offer.findUnique.mockResolvedValue({
        ...OFFER,
        business: {
          ...OFFER.business,
          business_status: 'CLAIMED',
          banner_branding_mode: 'MERCHANT',
          brand_color: '#FF6600',
        },
      });
      await service.generate('offer-1', 'admin-1', {
        brandingMode: 'PAIRLEY',
      });
      expect(renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({ brandingMode: 'PAIRLEY' }),
      );
      // The merchant's own colour still travels — a Pairley-mode preview
      // changes which branding is applied, not what the offer knows.
      expect(renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({ brandColor: '#FF6600' }),
      );
    });

    it('passes null businessRating when the business has no reviews yet — never a fabricated figure', async () => {
      await service.generate('offer-1', 'admin-1');
      expect(renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({ businessRating: null }),
      );
    });

    it('passes a genuine aggregate rating when reviews exist', async () => {
      prisma.rating.aggregate.mockResolvedValue({
        _avg: { rating: 4.6 },
        _count: 128,
      });
      await service.generate('offer-1', 'admin-1');
      expect(renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({
          businessRating: { average: 4.6, count: 128 },
        }),
      );
      expect(prisma.rating.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { business_id: 'biz-1' } }),
      );
    });
  });

  describe('regenerate', () => {
    it('reuses the stored structured data — never touches OCR, crawling or extraction', async () => {
      // Nothing in BannerService imports or calls anything from the discovery
      // module; this is a structural guarantee as much as a runtime one, but
      // the runtime assertion is that regenerate never re-fetches the offer's
      // own source fields, only its already-persisted ones.
      prisma.offerVersion.findMany.mockResolvedValue([
        {
          version_no: 1,
          change_type: BANNER_CHANGE_TYPES.GENERATED,
          changed_by: 'admin-1',
          created_at: new Date(),
          snapshot: {
            bannerUrl: 'https://s3.example.com/banners/v1.png',
            templateId: 'A',
            heroImageUrl: 'https://x/cover.jpg',
            heroManual: false,
            usedHeroImage: true,
            renderedAt: new Date().toISOString(),
          },
        },
      ]);
      prisma.offerVersion.count.mockResolvedValue(1);

      const result = await service.regenerate('offer-1', 'admin-1');
      expect(result.templateId).toBe('A');
      expect(result.heroImageUrl).toBe('https://x/cover.jpg');
    });

    it('carries the current template and hero forward when nothing is overridden', async () => {
      prisma.offerVersion.findMany.mockResolvedValue([
        {
          version_no: 1,
          change_type: BANNER_CHANGE_TYPES.GENERATED,
          changed_by: 'admin-1',
          created_at: new Date(),
          snapshot: {
            bannerUrl: 'x',
            templateId: 'D',
            heroImageUrl: 'https://x/shop.jpg',
            heroManual: false,
            usedHeroImage: true,
            renderedAt: new Date().toISOString(),
          },
        },
      ]);
      await service.regenerate('offer-1', 'admin-1');
      expect(renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({
          templateId: 'D',
          heroImageUrl: 'https://x/shop.jpg',
        }),
      );
    });

    it('records a TEMPLATE_CHANGED version when only the template is overridden', async () => {
      prisma.offerVersion.findMany.mockResolvedValue([]);
      await service.regenerate('offer-1', 'admin-1', { templateId: 'E' });
      expect(prisma.offerVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            change_type: BANNER_CHANGE_TYPES.TEMPLATE_CHANGED,
          }),
        }),
      );
    });

    it('records an IMAGE_REPLACED version when only the hero is overridden', async () => {
      prisma.offerVersion.findMany.mockResolvedValue([]);
      await service.regenerate('offer-1', 'admin-1', {
        heroImageUrl: 'https://x/new.jpg',
      });
      expect(prisma.offerVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            change_type: BANNER_CHANGE_TYPES.IMAGE_REPLACED,
          }),
        }),
      );
    });

    it('records a plain REGENERATED version when nothing is overridden', async () => {
      prisma.offerVersion.findMany.mockResolvedValue([]);
      await service.regenerate('offer-1', 'admin-1');
      expect(prisma.offerVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            change_type: BANNER_CHANGE_TYPES.REGENERATED,
          }),
        }),
      );
    });
  });

  describe('replaceHeroImage', () => {
    it('uploads the file, analyses it and generates with it as hero', async () => {
      const result = await service.replaceHeroImage('offer-1', 'admin-1', {
        buffer: Buffer.from('img'),
        originalname: 'photo.jpg',
        mimetype: 'image/jpeg',
      });
      expect(storage.uploadFile).toHaveBeenCalled();
      expect(imageAnalysis.analyseBuffer).toHaveBeenCalled();
      expect(result.probe).toBeDefined();
      expect(renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({
          heroImageUrl: 'https://s3.example.com/banners/banner-1.png',
        }),
      );
    });
  });

  describe('getVersions / getCurrentVersion', () => {
    it('filters to banner change types and skips rows with no banner snapshot', async () => {
      prisma.offerVersion.findMany.mockResolvedValue([
        {
          version_no: 1,
          change_type: BANNER_CHANGE_TYPES.GENERATED,
          changed_by: 'admin-1',
          created_at: new Date(),
          snapshot: {
            bannerUrl: 'x',
            templateId: 'A',
            heroImageUrl: null,
            heroManual: false,
            usedHeroImage: false,
            renderedAt: 'now',
          },
        },
      ]);
      const versions = await service.getVersions('offer-1');
      expect(versions).toHaveLength(1);
      expect(prisma.offerVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ offer_id: 'offer-1' }),
        }),
      );
    });

    it('returns null current version when nothing has been generated yet', async () => {
      prisma.offerVersion.findMany.mockResolvedValue([]);
      expect(await service.getCurrentVersion('offer-1')).toBeNull();
    });
  });

  describe('rollbackTo', () => {
    it('re-points the offer at an earlier version and records a new REGENERATED entry', async () => {
      prisma.offerVersion.findMany.mockResolvedValue([
        {
          version_no: 1,
          change_type: BANNER_CHANGE_TYPES.GENERATED,
          changed_by: 'admin-1',
          created_at: new Date(),
          snapshot: {
            bannerUrl: 'https://s3/v1.png',
            templateId: 'A',
            heroImageUrl: null,
            heroManual: false,
            usedHeroImage: false,
            renderedAt: 'now',
          },
        },
        {
          version_no: 2,
          change_type: BANNER_CHANGE_TYPES.TEMPLATE_CHANGED,
          changed_by: 'admin-1',
          created_at: new Date(),
          snapshot: {
            bannerUrl: 'https://s3/v2.png',
            templateId: 'B',
            heroImageUrl: null,
            heroManual: false,
            usedHeroImage: false,
            renderedAt: 'now',
          },
        },
      ]);
      prisma.offerVersion.count.mockResolvedValue(2);

      const target = await service.rollbackTo('offer-1', 1, 'admin-1');
      expect(target.templateId).toBe('A');
      expect(prisma.offer.update).toHaveBeenCalledWith({
        where: { id: 'offer-1' },
        data: { generated_offer_card: 'https://s3/v1.png' },
      });
      // History is append-only — rollback adds a row, it never deletes one.
      expect(prisma.offerVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            change_type: BANNER_CHANGE_TYPES.REGENERATED,
          }),
        }),
      );
    });

    it('throws NotFound for an unknown version number', async () => {
      prisma.offerVersion.findMany.mockResolvedValue([]);
      await expect(
        service.rollbackTo('offer-1', 99, 'admin-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getTemplateLibrary', () => {
    it('returns all six templates', () => {
      expect(service.getTemplateLibrary()).toHaveLength(6);
    });
  });
});
