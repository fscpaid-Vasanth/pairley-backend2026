import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { BannerRenderService } from './banner-render.service';
import { ImageAnalysisService, ImageProbe } from './image-analysis.service';
import {
  ImageCandidate,
  ImageRole,
  RankedImage,
  selectHeroImage,
} from './heroImageRanking';
import {
  TemplateId,
  BANNER_TEMPLATES,
  TEMPLATE_IDS,
  isTemplateId,
  recommendTemplate,
  orientationOf,
  TemplateRecommendation,
} from './bannerTemplates';
import {
  BANNER_HEIGHT,
  BANNER_WIDTH,
  computeDiscountPercent,
} from './bannerLayout';
import { isCostSplitEligible } from './costSplitBanner';

/**
 * Module 14 Phase 3C — the banner lifecycle.
 *
 *   import → generate → store → admin preview → publish
 *                           ↖ regenerate, only when asked
 *
 * Two things this service is careful about:
 *
 *  1. **Regeneration rebuilds the banner and nothing else.** It never
 *     re-crawls a website, re-runs OCR or re-extracts fields — it reads the
 *     structured data already on the Offer. Changing a template must cost a
 *     render, not a full import.
 *  2. **The banner is stored, not recomputed on read.** `generated_offer_card`
 *     holds the current image, so a page load is a URL, not a render.
 *
 * Version history reuses the existing append-only `OfferVersion` table rather
 * than introducing a new one: it already carries a JSON snapshot, the acting
 * admin and a change type, which is exactly an audit trail. Each banner
 * revision is a row, so rollback is "re-point the offer at an earlier
 * snapshot's URL".
 */

const UPLOAD_FOLDER = 'banners';

export const BANNER_CHANGE_TYPES = {
  GENERATED: 'BANNER_GENERATED',
  TEMPLATE_CHANGED: 'BANNER_TEMPLATE_CHANGED',
  IMAGE_REPLACED: 'BANNER_IMAGE_REPLACED',
  REGENERATED: 'BANNER_REGENERATED',
} as const;

export type BannerChangeType =
  (typeof BANNER_CHANGE_TYPES)[keyof typeof BANNER_CHANGE_TYPES];

export interface BannerSnapshot {
  bannerUrl: string;
  templateId: TemplateId;
  heroImageUrl: string | null;
  /** True when the admin picked the image rather than the ranker. */
  heroManual: boolean;
  usedHeroImage: boolean;
  renderedAt: string;
}

export interface BannerVersion extends BannerSnapshot {
  versionNo: number;
  changeType: string;
  changedBy: string | null;
  createdAt: Date;
}

export interface BannerPlan {
  templateRecommendation: TemplateRecommendation;
  templateId: TemplateId;
  heroImageUrl: string | null;
  heroRanking: RankedImage[];
  heroNeedsReview: boolean;
  heroReviewReason: string | null;
  probes: ImageProbe[];
}

export interface BannerResult {
  bannerUrl: string;
  templateId: TemplateId;
  heroImageUrl: string | null;
  usedHeroImage: boolean;
  versionNo: number;
  plan: BannerPlan;
}

@Injectable()
export class BannerService {
  private readonly logger = new Logger(BannerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly renderer: BannerRenderService,
    private readonly imageAnalysis: ImageAnalysisService,
  ) {}

  /**
   * Everything the admin preview screen needs, without rendering anything:
   * the ranked images with their measurements, and the template
   * recommendation with per-template scores.
   */
  async buildPlan(
    offerId: string,
    overrides: {
      templateId?: string | null;
      heroImageUrl?: string | null;
      /**
       * Manual, per-image watermark calls (url -> true/false). Not
       * persisted here — the caller re-sends whatever it wants applied for
       * this computation. `generate()` snapshots the resulting hero choice,
       * not the flag map itself, matching every other override in this
       * service.
       */
      watermarkFlags?: Record<string, boolean> | null;
    } = {},
  ): Promise<BannerPlan> {
    const offer = await this.loadOffer(offerId);

    const roles = this.collectImageRoles(offer);
    const probes = await this.imageAnalysis.probeAll([...roles.keys()]);
    const candidates: ImageCandidate[] = this.imageAnalysis
      .toCandidates(probes, (url) => roles.get(url) ?? 'PRODUCT')
      .map((candidate) => {
        const flag = overrides.watermarkFlags?.[candidate.url];
        return flag === undefined
          ? candidate
          : { ...candidate, watermarkSuspected: flag };
      });

    const selection = selectHeroImage(candidates, {
      targetAspect: BANNER_WIDTH / BANNER_HEIGHT,
      minWidth: Math.round(BANNER_WIDTH * 0.75),
    });

    // An explicit admin choice always wins over the ranker — that's the whole
    // point of offering the override.
    const manualHero = overrides.heroImageUrl?.trim() || null;
    const heroImageUrl =
      manualHero ?? selection.selected?.candidate.url ?? null;

    const heroProbe = probes.find((probe) => probe.url === heroImageUrl);
    const recommendation = recommendTemplate({
      category: offer.category,
      offerType: offer.offer_type,
      heroOrientation:
        heroProbe?.orientation ??
        orientationOf(heroProbe?.width, heroProbe?.height),
      hasHeroImage: Boolean(heroImageUrl),
      titleLength: (offer.title ?? '').length,
      badgeCount: this.countBadges(offer),
      // Computed from the same function the renderer itself uses for the
      // cost-split box, so "is Template F recommended" and "would its
      // headline math box actually have content" can never disagree.
      costSplitEligible: isCostSplitEligible(
        offer.original_price,
        offer.offer_price,
        offer.required_people,
      ),
      requiredPeople: offer.required_people,
      discountPercent: computeDiscountPercent(
        offer.original_price,
        offer.offer_price,
      ),
    });

    return {
      templateRecommendation: recommendation,
      templateId: isTemplateId(overrides.templateId)
        ? overrides.templateId
        : recommendation.templateId,
      heroImageUrl,
      heroRanking: selection.ranked,
      heroNeedsReview: manualHero ? false : selection.needsReview,
      heroReviewReason: manualHero ? null : selection.reviewReason,
      probes,
    };
  }

  /**
   * Renders, stores and records a banner. This is the only writer of
   * `generated_offer_card`.
   */
  async generate(
    offerId: string,
    adminId: string | null,
    options: {
      templateId?: string | null;
      heroImageUrl?: string | null;
      watermarkFlags?: Record<string, boolean> | null;
      /** Admin preview override — lets the studio show either mode without
       *  changing the merchant's stored preference. */
      brandingMode?: string | null;
      changeType?: BannerChangeType;
    } = {},
  ): Promise<BannerResult> {
    const offer = await this.loadOffer(offerId);
    const plan = await this.buildPlan(offerId, options);

    const rendered = await this.renderer.render({
      title: offer.title,
      offerType: offer.offer_type,
      originalPrice: offer.original_price,
      offerPrice: offer.offer_price,
      requiredPeople: offer.required_people,
      category: offer.category,
      businessName: offer.business?.business_name ?? null,
      businessStatus: offer.business?.business_status ?? null,
      city: offer.business?.city ?? null,
      mallName: offer.business?.mall_name ?? null,
      merchantVerified: offer.merchant_verified,
      isPairleyExclusive: offer.is_pairley_exclusive,
      source: offer.source,
      heroImageUrl: plan.heroImageUrl,
      logoUrl: offer.business?.logo ?? null,
      templateId: plan.templateId,
      offerId: offer.id,
      businessRating: await this.getBusinessRating(offer.business_id),
      // The merchant's stored preference. resolveBranding() decides whether
      // it can actually be honoured — an unclaimed business is downgraded
      // to Pairley branding with a stated reason rather than silently.
      brandingMode:
        options.brandingMode ?? offer.business?.banner_branding_mode,
      brandColor: offer.business?.brand_color,
    });

    const bannerUrl = await this.storage.uploadFile(
      {
        buffer: rendered.buffer,
        originalname: `banner-${offerId}-${plan.templateId}.png`,
        mimetype: 'image/png',
      } as Express.Multer.File,
      UPLOAD_FOLDER,
    );

    const snapshot: BannerSnapshot = {
      bannerUrl,
      templateId: plan.templateId,
      heroImageUrl: plan.heroImageUrl,
      heroManual: Boolean(options.heroImageUrl),
      usedHeroImage: rendered.usedHeroImage,
      renderedAt: new Date().toISOString(),
    };

    const versionNo = await this.recordVersion(
      offerId,
      adminId,
      options.changeType ?? BANNER_CHANGE_TYPES.GENERATED,
      snapshot,
    );

    await this.prisma.offer.update({
      where: { id: offerId },
      data: { generated_offer_card: bannerUrl },
    });

    this.logger.log(
      `Banner ${options.changeType ?? 'GENERATED'} for offer ${offerId} — template ${plan.templateId}, v${versionNo}`,
    );

    return {
      bannerUrl,
      templateId: plan.templateId,
      heroImageUrl: plan.heroImageUrl,
      usedHeroImage: rendered.usedHeroImage,
      versionNo,
      plan,
    };
  }

  /**
   * Rebuilds the banner only. Deliberately reuses the stored structured data
   * — no crawl, no OCR, no extraction. The current template and hero are
   * carried forward unless the caller changes them.
   */
  async regenerate(
    offerId: string,
    adminId: string | null,
    options: {
      templateId?: string | null;
      heroImageUrl?: string | null;
      watermarkFlags?: Record<string, boolean> | null;
      brandingMode?: string | null;
    } = {},
  ): Promise<BannerResult> {
    const current = await this.getCurrentVersion(offerId);

    const templateId = options.templateId ?? current?.templateId ?? null;
    const heroImageUrl =
      options.heroImageUrl !== undefined
        ? options.heroImageUrl
        : (current?.heroImageUrl ?? null);

    const changeType = options.templateId
      ? BANNER_CHANGE_TYPES.TEMPLATE_CHANGED
      : options.heroImageUrl
        ? BANNER_CHANGE_TYPES.IMAGE_REPLACED
        : BANNER_CHANGE_TYPES.REGENERATED;

    return this.generate(offerId, adminId, {
      templateId,
      heroImageUrl,
      watermarkFlags: options.watermarkFlags,
      brandingMode: options.brandingMode,
      changeType,
    });
  }

  /**
   * Stores an admin-supplied replacement image and rebuilds with it. The
   * upload is analysed the same way a discovered image is, so the admin sees
   * the same quality read-out for their own file.
   */
  async replaceHeroImage(
    offerId: string,
    adminId: string | null,
    file: { buffer: Buffer; originalname: string; mimetype: string },
  ): Promise<BannerResult & { probe: ImageProbe }> {
    await this.loadOffer(offerId);

    const heroImageUrl = await this.storage.uploadFile(
      file as Express.Multer.File,
      UPLOAD_FOLDER,
    );
    const probe = await this.imageAnalysis.analyseBuffer(
      heroImageUrl,
      file.buffer,
    );

    const result = await this.generate(offerId, adminId, {
      heroImageUrl,
      // The template recommendation is re-run inside generate(), so replacing
      // the image can legitimately change the suggested layout — a portrait
      // upload should be allowed to move the offer to the split template.
      changeType: BANNER_CHANGE_TYPES.IMAGE_REPLACED,
    });

    return { ...result, probe };
  }

  /** Full banner history for an offer, oldest first. */
  async getVersions(offerId: string): Promise<BannerVersion[]> {
    const rows = await this.prisma.offerVersion.findMany({
      where: {
        offer_id: offerId,
        change_type: { in: Object.values(BANNER_CHANGE_TYPES) },
      },
      orderBy: { version_no: 'asc' },
    });

    return rows
      .map((row) => {
        const snapshot = row.snapshot as unknown as BannerSnapshot | null;
        if (!snapshot?.bannerUrl) return null;
        return {
          ...snapshot,
          versionNo: row.version_no,
          changeType: row.change_type,
          changedBy: row.changed_by,
          createdAt: row.created_at,
        };
      })
      .filter((version): version is BannerVersion => version !== null);
  }

  async getCurrentVersion(offerId: string): Promise<BannerVersion | null> {
    const versions = await this.getVersions(offerId);
    return versions.length ? versions[versions.length - 1] : null;
  }

  /**
   * Rollback: re-point the offer at an earlier revision's image. Recorded as
   * a new version rather than by deleting history, keeping the trail
   * append-only like every other audit surface in this codebase.
   */
  async rollbackTo(
    offerId: string,
    versionNo: number,
    adminId: string | null,
  ): Promise<BannerVersion> {
    const versions = await this.getVersions(offerId);
    const target = versions.find((version) => version.versionNo === versionNo);
    if (!target) {
      throw new NotFoundException('Banner version not found');
    }

    await this.recordVersion(
      offerId,
      adminId,
      BANNER_CHANGE_TYPES.REGENERATED,
      {
        bannerUrl: target.bannerUrl,
        templateId: target.templateId,
        heroImageUrl: target.heroImageUrl,
        heroManual: target.heroManual,
        usedHeroImage: target.usedHeroImage,
        renderedAt: new Date().toISOString(),
      },
    );

    await this.prisma.offer.update({
      where: { id: offerId },
      data: { generated_offer_card: target.bannerUrl },
    });

    return target;
  }

  /** The template library, for the admin's template picker. */
  getTemplateLibrary() {
    return TEMPLATE_IDS.map((id) => BANNER_TEMPLATES[id]);
  }

  private async recordVersion(
    offerId: string,
    adminId: string | null,
    changeType: string,
    snapshot: BannerSnapshot,
  ): Promise<number> {
    const existing = await this.prisma.offerVersion.count({
      where: { offer_id: offerId },
    });
    const versionNo = existing + 1;

    await this.prisma.offerVersion.create({
      data: {
        offer_id: offerId,
        version_no: versionNo,
        // BannerSnapshot is a plain, JSON-serialisable shape; Prisma's Json
        // input type just doesn't structurally recognise a named interface,
        // the same reason every other JSON snapshot write in this codebase
        // (OfferVersion, LeadMessage.payload, etc.) casts through unknown.
        snapshot: snapshot,
        changed_by: adminId,
        change_type: changeType,
      },
    });

    return versionNo;
  }

  /**
   * Every image the pipeline knows about for this offer, tagged with what it
   * is. Order of insertion matters only for the role assignment; the ranker
   * decides what actually wins.
   */
  private collectImageRoles(offer: {
    original_poster: string | null;
    cover_image: string | null;
    offer_image: string | null;
    gallery_images: string[];
    facility_images: string[];
    business?: { shop_photo: string | null; logo: string | null } | null;
  }): Map<string, ImageRole> {
    const roles = new Map<string, ImageRole>();
    const add = (url: string | null | undefined, role: ImageRole) => {
      if (url && !roles.has(url)) roles.set(url, role);
    };

    // The merchant's own promotional artwork, when the import captured it.
    add(offer.original_poster, 'OFFICIAL_BANNER');
    add(offer.cover_image, 'OFFER_HERO');
    add(offer.offer_image, 'OFFER_HERO');
    (offer.gallery_images ?? []).forEach((url) => add(url, 'PRODUCT'));
    (offer.facility_images ?? []).forEach((url) => add(url, 'INTERIOR'));
    add(offer.business?.shop_photo, 'EXTERIOR');
    add(offer.business?.logo, 'PLACEHOLDER');

    return roles;
  }

  /** How many chips the banner will carry — an input to template fit. */
  private countBadges(offer: {
    original_price: number;
    offer_price: number;
    required_people: number;
  }): number {
    let count = 1; // the origin badge is always present
    if (offer.original_price > offer.offer_price && offer.original_price > 0) {
      count += 2; // discount chip + savings line
    }
    if (offer.required_people > 1) count += 1;
    return count;
  }

  /**
   * A genuine aggregate from the Rating table — never a fabricated figure.
   * Returns null for a business with no reviews yet (the common case for a
   * freshly AI-discovered, unclaimed business), so the banner correctly
   * omits the rating line rather than inventing one. See
   * bannerLayout.ts's businessRatingLabel computation for the display side
   * of this same rule.
   */
  private async getBusinessRating(
    businessId: string,
  ): Promise<{ average: number; count: number } | null> {
    const result = await this.prisma.rating.aggregate({
      where: { business_id: businessId },
      _avg: { rating: true },
      _count: true,
    });
    if (!result._count || result._avg.rating === null) return null;
    return { average: result._avg.rating, count: result._count };
  }

  private async loadOffer(offerId: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: {
        business: {
          select: {
            business_name: true,
            business_status: true,
            city: true,
            mall_name: true,
            shop_photo: true,
            logo: true,
            banner_branding_mode: true,
            brand_color: true,
          },
        },
      },
    });
    if (!offer) throw new NotFoundException('Offer not found');
    return offer;
  }
}
