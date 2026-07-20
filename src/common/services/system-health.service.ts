import { Injectable } from '@nestjs/common';
import { HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from './storage.service';
import { getRelease } from '../utils/release.util';

export interface SystemHealthResult {
  status: 'ok' | 'degraded' | 'down';
  checks: {
    database: 'ok' | 'down';
    storage: 'ok' | 'unreachable';
  };
  release: string;
  environment: string;
  serverTime: string;
  processUptimeSeconds: number;
}

// Single source of truth for the DB/storage/release check used by both the
// public GET /api/health (uptime monitors) and the admin-gated
// GET /api/admin/system-health (the dashboard tile) — same checks, same
// result shape, so the two can never drift apart.
@Injectable()
export class SystemHealthService {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prismaService: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  async check(): Promise<SystemHealthResult> {
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

    return {
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
  }
}
