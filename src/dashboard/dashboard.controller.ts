import {
  Controller,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { OfferService } from '../offer/offer.service';
import { SystemHealthService } from '../common/services/system-health.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IsNotEmpty, IsString, IsIn, IsBoolean } from 'class-validator';

class VerifyBusinessDto {
  @IsString()
  @IsNotEmpty()
  status: 'APPROVED' | 'REJECTED' | 'PENDING';
}

class ModerateOfferDto {
  @IsIn([
    'ACTIVE',
    'REJECTED',
    'CLOSED',
    'DRAFT',
    'PENDING_APPROVAL',
    'PAUSED',
    'ARCHIVED',
    'EXPIRED',
  ])
  status: string;
}

class SetExclusiveDto {
  @IsBoolean()
  isExclusive: boolean;
}

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly offerService: OfferService,
    private readonly systemHealthService: SystemHealthService,
  ) {}

  // ==========================================
  // BUSINESS PORTAL ENDPOINTS
  // ==========================================
  @Get('business/dashboard')
  @Roles(Role.BUSINESS)
  async getBusinessDashboard(@CurrentUser() user: any) {
    return this.dashboardService.getBusinessMetrics(user.sub);
  }

  // ==========================================
  // ADMIN PORTAL ENDPOINTS
  // ==========================================
  @Get('admin/dashboard')
  @Roles(Role.ADMIN)
  async getAdminDashboard() {
    return this.dashboardService.getAdminMetrics();
  }

  // Same checks as the public GET /api/health, but admin-gated and always
  // 200 (even when a check fails) — this backs a dashboard tile, not an
  // uptime monitor, so the caller wants the status in the body rather than
  // having the fetch itself fail.
  @Get('admin/system-health')
  @Roles(Role.ADMIN)
  async getSystemHealth() {
    return this.systemHealthService.check();
  }

  // TEMPORARY — Module 7 Sentry verification only (see MONITORING_SETUP.md
  // §7). Admin-gated rather than NODE_ENV-gated because there's no separate
  // staging environment; this must be triggerable on the actual deployed
  // instance where SENTRY_DSN is configured. Remove once the test exception
  // is confirmed in Sentry.
  @Get('admin/test-sentry-exception')
  @Roles(Role.ADMIN)
  testSentryException(): never {
    throw new Error(
      'Module 7 Sentry verification test exception — safe to ignore, this is intentional.',
    );
  }

  @Get('admin/businesses')
  @Roles(Role.ADMIN)
  async getBusinesses(@Query('status') status?: string) {
    return this.dashboardService.listBusinesses(status);
  }

  @Put('admin/business/verify/:id')
  @Roles(Role.ADMIN)
  async verifyBusiness(
    @Param('id') id: string,
    @Body() body: VerifyBusinessDto,
  ) {
    return this.dashboardService.verifyBusiness(id, body.status);
  }

  @Get('admin/customers')
  @Roles(Role.ADMIN)
  async getCustomers() {
    return this.dashboardService.listCustomers();
  }

  @Put('admin/offers/moderate/:id')
  @Roles(Role.ADMIN)
  async moderateOffer(@Param('id') id: string, @Body() body: ModerateOfferDto) {
    return this.dashboardService.moderateOffer(id, body.status);
  }

  // Real, permanent delete — never exposed to the merchant-facing UI (that
  // path archives instead, see offer.service.ts's deleteOffer()). No
  // separate "Super Admin" role/tier exists in this system today, so this
  // is gated behind the existing Role.ADMIN — flagging that distinction in
  // case a stricter tier is introduced later.
  @Delete('admin/offers/:id/permanent')
  @Roles(Role.ADMIN)
  async permanentlyDeleteOffer(@Param('id') id: string) {
    return this.offerService.permanentlyDeleteOffer(id);
  }

  // Dormant — sets the "Pairley Exclusive" badge flag. No frontend UI calls
  // this yet (Module 4 ships the badge *display* only); an admin-tools
  // module will add a button for it later. Exists and is guarded now so the
  // capability is real and testable ahead of that UI.
  @Put('admin/offers/:id/exclusive')
  @Roles(Role.ADMIN)
  async setOfferExclusive(
    @Param('id') id: string,
    @Body() body: SetExclusiveDto,
  ) {
    return this.offerService.setPairleyExclusive(id, body.isExclusive);
  }

  @Get('admin/subscriptions')
  @Roles(Role.ADMIN)
  async getSubscriptions() {
    return this.dashboardService.listSubscriptions();
  }

  @Get('admin/tickets')
  @Roles(Role.ADMIN)
  async getSupportTickets(@Query('status') status?: string) {
    return this.dashboardService.listSupportTickets(status);
  }

  @Get('admin/categories')
  @Roles(Role.ADMIN)
  async getCategories() {
    return this.dashboardService.getCategories();
  }
}
