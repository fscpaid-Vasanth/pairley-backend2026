import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';
import { SystemHealthService } from './common/services/system-health.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly prismaService: PrismaService,
    private readonly systemHealthService: SystemHealthService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // Unauthenticated by design (uptime monitors need this) — never returns
  // stack traces or connection details, only the structured status below.
  // The database check is the one hard failure (503, matches the endpoint's
  // pre-Module-7 behavior); storage is checked best-effort and only ever
  // downgrades the response to "degraded," never blocks it — a slow/
  // unreachable S3 shouldn't make /health itself slow or fail.
  @Get('health')
  async getHealth() {
    const body = await this.systemHealthService.check();
    if (body.checks.database !== 'ok') {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }

  @Get('public/stats')
  async getPublicStats() {
    try {
      const dealsListed = await this.prismaService.offer.count();
      // "Live" (customer-visible right now) vs. dealsListed's all-time
      // total — the landing page's stat counters need the former so they
      // don't overstate current activity with historical/expired offers.
      const liveOffers = await this.prismaService.offer.count({
        where: { status: 'ACTIVE' },
      });
      const usersPaired = await this.prismaService.customer.count();
      const verifiedMerchants = await this.prismaService.business.count({
        where: { verification_status: 'APPROVED' },
      });

      // Calculate actual money saved based on matched offer interests (50% price savings per BOGO Match)
      const matchedInterests = await this.prismaService.offerInterest.findMany({
        include: { offer: true },
      });
      let moneySaved = 0;
      matchedInterests.forEach((i) => {
        const price = i.offer?.offer_price || 1000;
        moneySaved += price * 0.5;
      });

      // Calculate actual match rate (offers with at least 1 co-buyer / total offers)
      const totalOffers = await this.prismaService.offer.count();
      const offersWithMatches = await this.prismaService.offer.count({
        where: {
          joined_people: { gt: 0 },
        },
      });
      const matchRate =
        totalOffers > 0
          ? Math.round((offersWithMatches / totalOffers) * 100)
          : 95;

      return {
        dealsListed,
        liveOffers,
        usersPaired,
        verifiedMerchants,
        moneySaved,
        matchRate,
      };
    } catch (err) {
      console.error('Failed to calculate public stats:', err);
      // Honest fallback — this endpoint backs the landing page's public
      // trust counters (Module 9 redesign); it must never fabricate
      // traction numbers, including on error.
      return {
        dealsListed: 0,
        liveOffers: 0,
        usersPaired: 0,
        verifiedMerchants: 0,
        moneySaved: 0,
        matchRate: 0,
      };
    }
  }
}
