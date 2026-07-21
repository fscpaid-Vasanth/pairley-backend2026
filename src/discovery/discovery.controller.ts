import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsUrl } from 'class-validator';
import { ImportJobStatus } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';
import { ImportOrchestrationService } from './import-orchestration.service';
import { ImportJobRepository } from './import-job.repository';

class ImportWebsiteDto {
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  source_url: string;
}

// Admin-only for all of Phase 2 — no merchant/customer-facing surface yet.
// The review-queue/promote/takedown endpoints land in Phase 3.
@Controller('discovery')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class DiscoveryController {
  constructor(
    private readonly importOrchestrationService: ImportOrchestrationService,
    private readonly importJobRepo: ImportJobRepository,
  ) {}

  @Post('import')
  importWebsite(@Body() body: ImportWebsiteDto) {
    return this.importOrchestrationService.importFromWebsite(body.source_url);
  }

  @Get('jobs')
  listJobs(@Query('status') status?: ImportJobStatus) {
    return this.importJobRepo.findJobs(status ? { status } : undefined);
  }

  @Get('jobs/:id')
  async getJob(@Param('id') id: string) {
    const job = await this.importJobRepo.findJobById(id);
    if (!job) {
      throw new NotFoundException('Import job not found');
    }
    return job;
  }
}
