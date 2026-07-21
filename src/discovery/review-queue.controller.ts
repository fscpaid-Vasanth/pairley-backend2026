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
import { IsArray, IsOptional, IsString, ArrayNotEmpty } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ReviewQueueService, ReviewStatus } from './review-queue.service';

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
  approve(@Param('id') id: string, @CurrentUser() admin: { sub: string }) {
    return this.reviewQueueService.approve(id, admin.sub);
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
