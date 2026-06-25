import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly prismaService: PrismaService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  async getHealth() {
    try {
      await this.prismaService.$queryRaw`SELECT 1`;
      return {
        status: 'OK',
        database: 'Connected',
      };
    } catch (error) {
      console.error('Database health check failed:', error);
      throw new ServiceUnavailableException({
        status: 'Error',
        database: 'Disconnected',
      });
    }
  }
}
