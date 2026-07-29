import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsArray,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ArrayNotEmpty,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OfferType } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ReviewQueueService, ReviewStatus } from './review-queue.service';
import { OFFER_CATEGORIES } from '../offer/offer.controller';

const REVIEW_STATUSES: ReviewStatus[] = [
  'REVIEW_REQUIRED',
  'APPROVED',
  'REJECTED',
  'TAKEN_DOWN',
];

class RejectDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

// Module 11 Phase 4 — what the admin decided in the AI Suggestions panel.
// Every field independently optional: omitted = "keep the current value,"
// exactly matching CandidateOverrides on the service side. category is
// validated against the same real 12-item taxonomy offer creation uses;
// offerType against the real Prisma enum — an admin-supplied override gets
// exactly the same validation rigor as a merchant's own offer submission.
//
// Module 14 Phase 1 widened this to the full editable candidate. Every
// field keeps the same optional-means-unchanged contract, and every one is
// validated as strictly as the merchant-facing offer form would validate
// it — an AI-extracted value that an admin waves through must not be able
// to enter the catalogue in a shape a merchant could never have submitted.
class CandidateOverridesDto {
  @IsOptional()
  @IsIn(OFFER_CATEGORIES)
  category?: string;

  @IsOptional()
  @IsEnum(OfferType)
  offerType?: OfferType;

  @IsOptional()
  @IsString()
  merchantType?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  subtitle?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  originalPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  offerPrice?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  requiredPeople?: number;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  startDate?: Date;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  endDate?: Date;

  @IsOptional()
  @IsString()
  coverImage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  businessName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  businessCategory?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  businessMobile?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  businessEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  businessAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  businessCity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  businessState?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  businessPincode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  businessWebsite?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  businessGstNumber?: string;
}

class ApproveDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CandidateOverridesDto)
  overrides?: CandidateOverridesDto;
}

// Same payload shape as approve, deliberately — "save my edits" and
// "save my edits and publish" differ only in whether the status moves.
class SaveDraftDto extends ApproveDto {}

class BulkIdsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids: string[];
}

class BulkRejectDto extends BulkIdsDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

// Module 9 Phase 3 — admin-only review queue for AI-imported offers.
// Separate controller from DiscoveryController (import-job endpoints) per
// the clean-architecture principle carried over from Phase 2: import-job
// concerns and review-queue concerns are different responsibilities.
@Controller('discovery/candidates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class ReviewQueueController {
  constructor(private readonly reviewQueueService: ReviewQueueService) {}

  @Get()
  list(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const reviewStatus =
      status && REVIEW_STATUSES.includes(status as ReviewStatus)
        ? (status as ReviewStatus)
        : undefined;
    return this.reviewQueueService.listCandidates({
      search,
      reviewStatus,
      page: page ? parseInt(page, 10) : 1,
      pageSize: pageSize ? parseInt(pageSize, 10) : 20,
    });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.reviewQueueService.getCandidate(id);
  }

  @Put(':id/approve')
  approve(
    @Param('id') id: string,
    @Body() body: ApproveDto,
    @CurrentUser() admin: { sub: string },
  ) {
    return this.reviewQueueService.approve(id, admin.sub, body?.overrides);
  }

  // Module 14 Phase 1 — persist edits without publishing. The candidate
  // stays REVIEW_REQUIRED, so it remains in the queue for someone to
  // finish.
  @Put(':id/draft')
  saveDraft(
    @Param('id') id: string,
    @Body() body: SaveDraftDto,
    @CurrentUser() admin: { sub: string },
  ) {
    return this.reviewQueueService.saveDraft(id, admin.sub, body?.overrides);
  }

  @Put(':id/reject')
  reject(
    @Param('id') id: string,
    @Body() body: RejectDto,
    @CurrentUser() admin: { sub: string },
  ) {
    return this.reviewQueueService.reject(id, admin.sub, body.reason);
  }

  @Put(':id/takedown')
  takedown(@Param('id') id: string, @CurrentUser() admin: { sub: string }) {
    return this.reviewQueueService.takedown(id, admin.sub);
  }

  @Post('bulk-approve')
  bulkApprove(@Body() body: BulkIdsDto, @CurrentUser() admin: { sub: string }) {
    return this.reviewQueueService.bulkApprove(body.ids, admin.sub);
  }

  @Post('bulk-reject')
  bulkReject(
    @Body() body: BulkRejectDto,
    @CurrentUser() admin: { sub: string },
  ) {
    return this.reviewQueueService.bulkReject(body.ids, admin.sub, body.reason);
  }
}
