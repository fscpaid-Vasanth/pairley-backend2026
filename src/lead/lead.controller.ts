import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsString, IsNotEmpty, IsOptional, IsObject } from 'class-validator';
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

// Module 13 Phase 2 — Deal Coordination Assistant. Replaces the old
// free-text SendLeadMessageDto ({ text }) — a message is now always a
// reference to a catalog entry (see leadMessageTemplates.ts), optionally
// with a structured payload (date+time or lat+lng) for the templates that
// need one. class-validator only confirms the *shape* here (a non-empty
// key string, an optional plain object); the actual whitelist/payload
// validation happens in renderLeadMessage(), which is what really decides
// whether this is accepted.
class SendLeadMessageDto {
  @IsString()
  @IsNotEmpty()
  templateKey: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
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

  // Module 13 Phase 2 — the structured-message catalog, fetched by both
  // roles before they ever open a specific lead. Declared before ':id'
  // below so Nest doesn't swallow this literal path as a lead id.
  @Get('message-templates')
  @Roles(Role.CUSTOMER, Role.BUSINESS)
  async getMessageTemplates() {
    return this.leadService.getMessageTemplates();
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

  // Module 13 — Phase 1 unlock: free, manual, business-only (matches the
  // controller's class-level @Roles(Role.BUSINESS), no override needed).
  @Post(':id/unlock')
  async unlockLead(@CurrentUser() user: any, @Param('id') id: string) {
    return this.leadService.unlockLead(user.sub, id);
  }

  // Module 13 — the anonymous 1:1 lead chat. @Roles here overrides the
  // controller's class-level Role.BUSINESS (RolesGuard uses
  // getAllAndOverride, so method-level metadata wins) — both the customer
  // and the business side of a Lead need to reach these two routes; which
  // specific lead they can touch is enforced inside LeadService via
  // assertLeadAccess(), not by role alone.
  @Get(':id/messages')
  @Roles(Role.CUSTOMER, Role.BUSINESS)
  async getMessages(@CurrentUser() user: any, @Param('id') id: string) {
    return this.leadService.getMessages(id, user.sub, user.role);
  }

  @Post(':id/messages')
  @Roles(Role.CUSTOMER, Role.BUSINESS)
  async sendMessage(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: SendLeadMessageDto,
  ) {
    return this.leadService.sendMessage(id, user.sub, user.role, body.templateKey, body.payload);
  }
}
