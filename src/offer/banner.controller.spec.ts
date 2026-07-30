import { BadRequestException } from '@nestjs/common';
import { BannerController } from './banner.controller';
import { BannerService } from './banner.service';

const ADMIN = { sub: 'admin-1' };

describe('BannerController (Module 14 Phase 3C)', () => {
  let bannerService: {
    buildPlan: jest.Mock;
    getVersions: jest.Mock;
    getCurrentVersion: jest.Mock;
    getTemplateLibrary: jest.Mock;
    generate: jest.Mock;
    regenerate: jest.Mock;
    replaceHeroImage: jest.Mock;
    rollbackTo: jest.Mock;
  };
  let fileValidation: { validate: jest.Mock; sanitizeFilename: jest.Mock };
  let controller: BannerController;

  beforeEach(() => {
    bannerService = {
      buildPlan: jest.fn().mockResolvedValue({
        templateRecommendation: {
          templateId: 'A',
          confidence: 0.8,
          reasons: [],
          scores: [],
        },
        templateId: 'A',
        heroImageUrl: 'https://x/img.jpg',
        heroRanking: [],
        heroNeedsReview: false,
        heroReviewReason: null,
        probes: [],
      }),
      getVersions: jest.fn().mockResolvedValue([]),
      getCurrentVersion: jest.fn().mockResolvedValue(null),
      getTemplateLibrary: jest.fn().mockReturnValue([{ id: 'A' }, { id: 'B' }]),
      generate: jest
        .fn()
        .mockResolvedValue({ bannerUrl: 'https://x/banner.png', versionNo: 1 }),
      regenerate: jest.fn().mockResolvedValue({
        bannerUrl: 'https://x/banner2.png',
        versionNo: 2,
      }),
      replaceHeroImage: jest.fn().mockResolvedValue({
        bannerUrl: 'https://x/banner3.png',
        versionNo: 3,
        probe: {},
      }),
      rollbackTo: jest.fn().mockResolvedValue({ versionNo: 1 }),
    };
    fileValidation = {
      validate: jest.fn(),
      sanitizeFilename: jest.fn().mockImplementation((name: string) => name),
    };
    controller = new BannerController(
      bannerService as unknown as BannerService,
      fileValidation,
    );
  });

  describe('preview', () => {
    it('assembles plan, versions and template library into one response', async () => {
      const result = await controller.preview('offer-1');
      expect(result.suggestedTemplateId).toBe('A');
      expect(result.templates).toHaveLength(2);
      expect(bannerService.buildPlan).toHaveBeenCalledWith('offer-1');
    });
  });

  describe('generate / regenerate', () => {
    it('forwards template, hero and watermark overrides on generate', async () => {
      await controller.generate(
        'offer-1',
        {
          templateId: 'C',
          heroImageUrl: 'https://x/img.jpg',
          watermarkFlags: [
            { url: 'https://x/img.jpg', watermarkSuspected: true },
          ],
        },
        ADMIN,
      );
      expect(bannerService.generate).toHaveBeenCalledWith(
        'offer-1',
        'admin-1',
        {
          templateId: 'C',
          heroImageUrl: 'https://x/img.jpg',
          watermarkFlags: { 'https://x/img.jpg': true },
        },
      );
    });

    it('omits watermarkFlags entirely when none are supplied, rather than sending {}', async () => {
      await controller.generate('offer-1', {}, ADMIN);
      const call = bannerService.generate.mock.calls[0] as [
        string,
        string,
        { watermarkFlags?: Record<string, boolean> },
      ];
      expect(call[2].watermarkFlags).toBeUndefined();
    });

    it('regenerate never re-derives structured data — it only forwards override options', async () => {
      await controller.regenerate('offer-1', { templateId: 'D' }, ADMIN);
      expect(bannerService.regenerate).toHaveBeenCalledWith(
        'offer-1',
        'admin-1',
        {
          templateId: 'D',
          heroImageUrl: undefined,
          watermarkFlags: undefined,
          brandingMode: undefined,
        },
      );
    });

    // The studio's Pairley/Merchant toggle is a preview control: it rides
    // on the render call and must never be mistaken for an edit to the
    // merchant's stored preference, so it travels no further than options.
    it('forwards a branding-mode preview on both generate and regenerate', async () => {
      await controller.generate('offer-1', { brandingMode: 'MERCHANT' }, ADMIN);
      expect(bannerService.generate).toHaveBeenCalledWith(
        'offer-1',
        'admin-1',
        expect.objectContaining({ brandingMode: 'MERCHANT' }),
      );

      await controller.regenerate(
        'offer-1',
        { brandingMode: 'PAIRLEY' },
        ADMIN,
      );
      expect(bannerService.regenerate).toHaveBeenCalledWith(
        'offer-1',
        'admin-1',
        expect.objectContaining({ brandingMode: 'PAIRLEY' }),
      );
    });

    // Absent toggle means "use whatever the merchant chose" — the service
    // reads the stored preference. Sending a default here would silently
    // override it on every render the admin didn't touch the toggle on.
    it('sends no branding mode at all when the admin has not overridden it', async () => {
      await controller.generate('offer-1', {}, ADMIN);
      const call = bannerService.generate.mock.calls[0] as [
        string,
        string,
        { brandingMode?: string },
      ];
      expect(call[2].brandingMode).toBeUndefined();
    });
  });

  describe('selectHero', () => {
    it('requires a heroImageUrl', () => {
      expect(() => controller.selectHero('offer-1', {}, ADMIN)).toThrow(
        BadRequestException,
      );
    });

    it('regenerates with the chosen hero, overriding automatic ranking', async () => {
      await controller.selectHero(
        'offer-1',
        { heroImageUrl: 'https://x/manual.jpg' },
        ADMIN,
      );
      expect(bannerService.regenerate).toHaveBeenCalledWith(
        'offer-1',
        'admin-1',
        {
          heroImageUrl: 'https://x/manual.jpg',
          templateId: undefined,
        },
      );
    });
  });

  describe('uploadHero', () => {
    it('rejects when no file is provided', async () => {
      await expect(
        controller.uploadHero('offer-1', ADMIN, undefined),
      ).rejects.toThrow(BadRequestException);
    });

    it('validates the file before handing it to the service', async () => {
      const file = {
        buffer: Buffer.from('img'),
        originalname: 'photo.jpg',
        mimetype: 'image/jpeg',
        size: 3,
      } as Express.Multer.File;

      await controller.uploadHero('offer-1', ADMIN, file);
      expect(fileValidation.validate).toHaveBeenCalledWith(
        expect.objectContaining({ mimetype: 'image/jpeg', size: 3 }),
      );
      expect(bannerService.replaceHeroImage).toHaveBeenCalledWith(
        'offer-1',
        'admin-1',
        expect.objectContaining({ originalname: 'photo.jpg' }),
      );
    });

    it('propagates a validation failure without reaching the service', async () => {
      fileValidation.validate.mockImplementation(() => {
        throw new BadRequestException('bad file');
      });
      const file = {
        buffer: Buffer.from('x'),
        originalname: 'x.exe',
        mimetype: 'application/octet-stream',
        size: 1,
      } as Express.Multer.File;

      await expect(
        controller.uploadHero('offer-1', ADMIN, file),
      ).rejects.toThrow('bad file');
      expect(bannerService.replaceHeroImage).not.toHaveBeenCalled();
    });
  });

  describe('rankImages', () => {
    it('converts the flag list into a url->boolean map for the service', async () => {
      await controller.rankImages('offer-1', {
        flags: [
          { url: 'https://x/a.jpg', watermarkSuspected: true },
          { url: 'https://x/b.jpg', watermarkSuspected: false },
        ],
      });
      expect(bannerService.buildPlan).toHaveBeenCalledWith('offer-1', {
        watermarkFlags: { 'https://x/a.jpg': true, 'https://x/b.jpg': false },
      });
    });

    it('handles no flags at all', async () => {
      await controller.rankImages('offer-1', {});
      expect(bannerService.buildPlan).toHaveBeenCalledWith('offer-1', {
        watermarkFlags: {},
      });
    });
  });

  describe('rollback', () => {
    it('forwards the version number and acting admin', async () => {
      await controller.rollback('offer-1', { versionNo: 2 }, ADMIN);
      expect(bannerService.rollbackTo).toHaveBeenCalledWith(
        'offer-1',
        2,
        'admin-1',
      );
    });
  });
});
