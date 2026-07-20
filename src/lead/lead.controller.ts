import {
  Controller,
  Get,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsIn } from 'class-validator';
import { LeadService } from './lead.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

const LEAD_STATUSES = [
  'NEW',
  'CONTACTED',
  'CONVERTED',
  'NOT_INTERESTED',
] as const;

class UpdateLeadStatusDto {
  @IsIn(LEAD_STATUSES)
  status: string;
}

@Controller('leads')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.BUSINESS)
export class LeadController {
  constructor(private readonly leadService: LeadService) {}

  @Get()
  async getLeads(
    @CurrentUser() user: any,
    @Query('offerId') offerId?: string,
    @Query('status') status?: string,
  ) {
    return this.leadService.getLeads(user.sub, { offerId, status });
  }

  @Get(':id')
  async getLead(@CurrentUser() user: any, @Param('id') id: string) {
    return this.leadService.getLead(user.sub, id);
  }

  @Put(':id/status')
  async updateLeadStatus(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: UpdateLeadStatusDto,
  ) {
    return this.leadService.updateLeadStatus(user.sub, id, body.status as any);
  }
}
