import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { EntitlementRuleType } from '@prisma/client';
import { EntitlementService } from './entitlement.service';
import { EntitlementAdminService } from './entitlement-admin.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

class UpsertPolicyDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEnum(EntitlementRuleType)
  ruleType: EntitlementRuleType;

  @IsOptional()
  rules?: Record<string, unknown>;

  @IsOptional()
  appliesTo?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  startsAt?: string | null;

  @IsOptional()
  @IsString()
  endsAt?: string | null;
}

class GrantCreditsDto {
  @IsString()
  @IsNotEmpty()
  businessId: string;

  @IsInt()
  credits: number;

  @IsString()
  @IsNotEmpty()
  reason: string;

  @IsOptional()
  @IsString()
  expiresAt?: string | null;
}

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class EntitlementController {
  constructor(
    private readonly entitlement: EntitlementService,
    private readonly admin: EntitlementAdminService,
  ) {}

  // ---------------------------------------------------------------------
  // Merchant — read-only view of their own current entitlement. Backs the
  // "Launch Benefit" banner and the Unlock button's enabled state, so the
  // UI never has to know which policies exist or how they are ranked.
  // ---------------------------------------------------------------------
  @Get('business/entitlement')
  @Roles(Role.BUSINESS)
  async myEntitlement(@CurrentUser() user: any) {
    const decision = await this.entitlement.evaluate(user.sub);
    return {
      allowed: decision.allowed,
      reason: decision.reason,
      message: decision.message,
      remaining: decision.remaining,
      isPromotional: decision.isPromotional,
      policyName: decision.policy?.name ?? null,
      endsAt: decision.policy?.endsAt ?? null,
    };
  }

  @Get('business/entitlement/history')
  @Roles(Role.BUSINESS)
  async myUnlockHistory(@CurrentUser() user: any) {
    return this.entitlement.listAuditForBusiness(user.sub);
  }

  // ---------------------------------------------------------------------
  // Admin — policy configuration. This is the whole "no deploy needed"
  // promise: pricing, quotas, campaign windows and eligibility are all
  // edited here.
  // ---------------------------------------------------------------------
  @Get('admin/entitlement/policies')
  @Roles(Role.ADMIN)
  async listPolicies() {
    return this.admin.listPolicies();
  }

  @Post('admin/entitlement/policies')
  @Roles(Role.ADMIN)
  async createPolicy(@Body() dto: UpsertPolicyDto) {
    return this.admin.createPolicy(dto);
  }

  @Put('admin/entitlement/policies/:id')
  @Roles(Role.ADMIN)
  async updatePolicy(@Param('id') id: string, @Body() dto: UpsertPolicyDto) {
    return this.admin.updatePolicy(id, dto);
  }

  @Delete('admin/entitlement/policies/:id')
  @Roles(Role.ADMIN)
  async deletePolicy(@Param('id') id: string) {
    return this.admin.deletePolicy(id);
  }

  /**
   * What a given business would get right now, and why. The support tool
   * for "why can't this merchant unlock?" — answered without reading logs.
   */
  @Get('admin/entitlement/preview')
  @Roles(Role.ADMIN)
  async preview(@Query('businessId') businessId: string) {
    return this.entitlement.evaluate(businessId);
  }

  @Get('admin/entitlement/audit')
  @Roles(Role.ADMIN)
  async audit(@Query('businessId') businessId?: string) {
    return this.admin.listAudit(businessId);
  }

  @Post('admin/entitlement/grants')
  @Roles(Role.ADMIN)
  async grantCredits(@Body() dto: GrantCreditsDto, @CurrentUser() user: any) {
    return this.admin.grantCredits(dto, user.sub);
  }
}
