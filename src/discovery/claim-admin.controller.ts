import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { ClaimRequestStatus } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ClaimRequestService } from './claim-request.service';

const CLAIM_STATUSES = Object.values(ClaimRequestStatus);

class RejectClaimDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

@Controller('business/claim/requests')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class ClaimAdminController {
  constructor(private readonly claimRequestService: ClaimRequestService) {}

  @Get()
  list(@Query('status') status?: string) {
    const parsed =
      status && CLAIM_STATUSES.includes(status as ClaimRequestStatus)
        ? (status as ClaimRequestStatus)
        : undefined;
    return this.claimRequestService.listRequests(parsed);
  }

  // Module 12 Phase 1 — the evidence-viewer detail fetch (Phase 3 builds
  // the UI against this). Placed before ':id/approve' etc. doesn't matter
  // here since Nest matches by method+exact-vs-param segment, not
  // declaration order, but kept alongside list() for readability.
  @Get(':id')
  get(@Param('id') id: string) {
    return this.claimRequestService.getRequestDetail(id);
  }

  @Put(':id/approve')
  approve(@Param('id') id: string, @CurrentUser() admin: { sub: string }) {
    return this.claimRequestService.approve(id, admin.sub);
  }

  @Put(':id/reject')
  reject(
    @Param('id') id: string,
    @Body() body: RejectClaimDto,
    @CurrentUser() admin: { sub: string },
  ) {
    return this.claimRequestService.reject(id, admin.sub, body.reason);
  }
}
