import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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

// Blunt hard ceiling at the Multer/transport layer — purely a DoS guard,
// deliberately higher than FileValidationService's real 15MB limit so a
// file between the two produces a clear FAILED ImportJob (the case that
// check actually exists to catch) rather than only a transport-level
// rejection with no audit trail.
const MULTER_HARD_SIZE_LIMIT_BYTES = 20 * 1024 * 1024;

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

  // 202 Accepted — the job is QUEUED/PROCESSING, not finished. Real
  // type/signature/size validation happens inside the service (see
  // FileValidationService); Multer's own filter is deliberately left
  // permissive here so every rejection reason ends up on a real ImportJob
  // record instead of some being a bare Multer error and others a job.
  @Post('import-file')
  @HttpCode(202)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MULTER_HARD_SIZE_LIMIT_BYTES },
    }),
  )
  importFile(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    return this.importOrchestrationService.importFromFile({
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalFilename: file.originalname,
    });
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
