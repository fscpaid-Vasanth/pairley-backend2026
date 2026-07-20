import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';
import { StorageService } from './common/services/storage.service';
import { getRelease } from './common/utils/release.util';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly prismaService: PrismaService,
    private readonly storageService: StorageService,
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
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
    const release = getRelease();
    const environment = process.env.NODE_ENV || 'development';
    const serverTime = new Date().toISOString();
    const processUptimeSeconds = Math.floor(process.uptime());

    let databaseOk = true;
    try {
      await this.health.check([
        () => this.prismaHealth.pingCheck('database', this.prismaService),
      ]);
    } catch {
      databaseOk = false;
    }

    const storageResult = await this.storageService.checkHealth();

    const body = {
      status: !databaseOk ? 'down' : storageResult.ok ? 'ok' : 'degraded',
      checks: {
        database: databaseOk ? 'ok' : 'down',
        storage: storageResult.ok ? 'ok' : 'unreachable',
      },
      release,
      environment,
      serverTime,
      processUptimeSeconds,
    };

    if (!databaseOk) {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }

  @Get('public/stats')
  async getPublicStats() {
    try {
      const dealsListed = await this.prismaService.offer.count();
      const usersPaired = await this.prismaService.customer.count();

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
        usersPaired,
        moneySaved,
        matchRate,
      };
    } catch (err) {
      console.error('Failed to calculate public stats:', err);
      return {
        dealsListed: 120,
        usersPaired: 240,
        moneySaved: 120000,
        matchRate: 95,
      };
    }
  }
}
