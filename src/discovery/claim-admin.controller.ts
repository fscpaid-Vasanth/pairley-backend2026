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
