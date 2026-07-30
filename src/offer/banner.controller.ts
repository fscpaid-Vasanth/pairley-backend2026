import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Role, Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BannerService } from './banner.service';
import { FileValidationService } from '../discovery/file-validation.service';

class BannerOptionsDto {
  /** 'A'–'E'. Validated in the service via isTemplateId, not here, so an
   *  unknown id degrades to the default rather than 400-ing a whole render. */
  @IsOptional()
  @IsString()
  templateId?: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  heroImageUrl?: string;

  /**
   * Preview a branding mode without changing the merchant's stored
   * preference — the admin studio uses this to show Mode A vs Mode B side
   * by side. Unrecognised values fall through to the stored preference.
   */
  @IsOptional()
  @IsString()
  brandingMode?: string;

  /** Optional — apply these manual watermark calls before picking/scoring. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WatermarkFlagDto)
  watermarkFlags?: WatermarkFlagDto[];
}

class RollbackDto {
  @IsInt()
  @Min(1)
  versionNo: number;
}

class WatermarkFlagDto {
  @IsUrl({ require_protocol: true })
  url: string;

  // No `null` option here: "not assessed" is the absence of an entry, not a
  // stored null — the admin action is always either "flag" or "clear".
  @IsBoolean()
  watermarkSuspected: boolean;
}

class RankImagesDto {
  /**
   * The full set of manual watermark calls currently in effect, not a diff
   * — the caller (the admin UI's local state) always sends everything it
   * knows, and this recomputes the ranking from scratch against it.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WatermarkFlagDto)
  flags?: WatermarkFlagDto[];
}

// 20MB transport ceiling; FileValidationService applies the real 15MB limit
// and magic-byte checks, matching the Module 10 upload precedent.
const MULTER_HARD_SIZE_LIMIT_BYTES = 20 * 1024 * 1024;

function toFlagMap(
  flags: WatermarkFlagDto[] | undefined,
): Record<string, boolean> | undefined {
  if (!flags || flags.length === 0) return undefined;
  return Object.fromEntries(
    flags.map((flag) => [flag.url, flag.watermarkSuspected]),
  );
}

/**
 * Module 14 Phase 3C — the banner API.
 *
 * Thin by design: every decision lives in BannerService, heroImageRanking and
 * bannerTemplates. This file only maps HTTP to those, so the recommendation
 * engine stays usable (and testable) without a request in sight.
 *
 * Admin-only throughout — banners are produced during review, and none of
 * this is reachable by a merchant or customer.
 */
@Controller('discovery/candidates/:id/banner')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class BannerController {
  constructor(
    private readonly bannerService: BannerService,
    private readonly fileValidation: FileValidationService,
  ) {}

  /**
   * Everything the preview screen needs, WITHOUT rendering: ranked images
   * with their measurements, the template recommendation and per-template
   * scores, and the currently stored banner. Safe to call on page load.
   */
  @Get('preview')
  async preview(@Param('id') id: string) {
    const [plan, versions, current] = await Promise.all([
      this.bannerService.buildPlan(id),
      this.bannerService.getVersions(id),
      this.bannerService.getCurrentVersion(id),
    ]);

    return {
      current,
      versions,
      recommendation: plan.templateRecommendation,
      suggestedTemplateId: plan.templateId,
      heroImageUrl: plan.heroImageUrl,
      heroRanking: plan.heroRanking,
      heroNeedsReview: plan.heroNeedsReview,
      heroReviewReason: plan.heroReviewReason,
      imageAnalysis: plan.probes,
      templates: this.bannerService.getTemplateLibrary(),
    };
  }

  /** Image ranking on its own, for the image picker. */
  @Get('images')
  async images(@Param('id') id: string) {
    const plan = await this.bannerService.buildPlan(id);
    return {
      selected: plan.heroImageUrl,
      ranking: plan.heroRanking,
      analysis: plan.probes,
      needsReview: plan.heroNeedsReview,
      reviewReason: plan.heroReviewReason,
    };
  }

  /**
   * Re-ranks images against a set of manual watermark calls, without
   * generating anything. Lets the admin try flagging an image and see the
   * effect before committing to a hero — nothing here is persisted; the
   * flags that end up mattering are whatever the eventual generate/
   * regenerate call is made with.
   */
  @Post('images/rank')
  async rankImages(@Param('id') id: string, @Body() body: RankImagesDto) {
    const watermarkFlags = Object.fromEntries(
      (body?.flags ?? []).map((flag) => [flag.url, flag.watermarkSuspected]),
    );
    const plan = await this.bannerService.buildPlan(id, { watermarkFlags });
    return {
      selected: plan.heroImageUrl,
      ranking: plan.heroRanking,
      needsReview: plan.heroNeedsReview,
      reviewReason: plan.heroReviewReason,
    };
  }

  /** Template recommendation on its own, optionally for a hypothetical hero. */
  @Get('template-recommendation')
  async templateRecommendation(@Param('id') id: string) {
    const plan = await this.bannerService.buildPlan(id);
    return {
      ...plan.templateRecommendation,
      templates: this.bannerService.getTemplateLibrary(),
    };
  }

  @Get('versions')
  versions(@Param('id') id: string) {
    return this.bannerService.getVersions(id);
  }

  /** First generation — or an explicit re-render with chosen options. */
  @Post()
  generate(
    @Param('id') id: string,
    @Body() body: BannerOptionsDto,
    @CurrentUser() admin: { sub: string },
  ) {
    return this.bannerService.generate(id, admin?.sub ?? null, {
      templateId: body?.templateId,
      heroImageUrl: body?.heroImageUrl,
      watermarkFlags: toFlagMap(body?.watermarkFlags),
      brandingMode: body?.brandingMode,
    });
  }

  /**
   * Rebuilds the banner only — never re-crawls, re-OCRs or re-extracts.
   * Carries the current template and hero forward unless overridden.
   */
  @Put('regenerate')
  regenerate(
    @Param('id') id: string,
    @Body() body: BannerOptionsDto,
    @CurrentUser() admin: { sub: string },
  ) {
    return this.bannerService.regenerate(id, admin?.sub ?? null, {
      templateId: body?.templateId,
      heroImageUrl: body?.heroImageUrl,
      watermarkFlags: toFlagMap(body?.watermarkFlags),
      brandingMode: body?.brandingMode,
    });
  }

  /** Select one of the already-detected images as the hero. */
  @Put('hero')
  selectHero(
    @Param('id') id: string,
    @Body() body: BannerOptionsDto,
    @CurrentUser() admin: { sub: string },
  ) {
    if (!body?.heroImageUrl) {
      throw new BadRequestException('heroImageUrl is required');
    }
    return this.bannerService.regenerate(id, admin?.sub ?? null, {
      heroImageUrl: body.heroImageUrl,
      templateId: body.templateId,
    });
  }

  /** Upload a replacement hero image and rebuild with it. */
  @Post('hero-upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MULTER_HARD_SIZE_LIMIT_BYTES },
    }),
  )
  async uploadHero(
    @Param('id') id: string,
    @CurrentUser() admin: { sub: string },
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');

    // Same magic-byte validation as every other upload path in the platform —
    // an admin-supplied file is still a file from outside.
    this.fileValidation.validate({
      mimetype: file.mimetype,
      size: file.size ?? file.buffer.length,
      buffer: file.buffer,
    });

    return this.bannerService.replaceHeroImage(id, admin?.sub ?? null, {
      buffer: file.buffer,
      originalname: this.fileValidation.sanitizeFilename(file.originalname),
      mimetype: file.mimetype,
    });
  }

  @Put('rollback')
  rollback(
    @Param('id') id: string,
    @Body() body: RollbackDto,
    @CurrentUser() admin: { sub: string },
  ) {
    return this.bannerService.rollbackTo(
      id,
      body.versionNo,
      admin?.sub ?? null,
    );
  }
}
