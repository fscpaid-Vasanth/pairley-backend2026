import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImportJobRepository } from './import-job.repository';
import { UrlFetchService } from './url-fetch.service';
import { ContentExtractionService } from './content-extraction.service';
import { ConfidenceScoringService } from './confidence-scoring.service';
import { ImportOrchestrationService } from './import-orchestration.service';
import { DiscoveryController } from './discovery.controller';

// Module 9 — AI Offer Discovery (Group B). Phase 2 adds the website-import
// pipeline (fetch -> extract -> score) behind one admin endpoint. The admin
// review-queue controller (Phase 3) and claim-flow endpoints (Phase 4) will
// import this module's exported providers rather than duplicating them.
@Module({
  imports: [AuthModule],
  controllers: [DiscoveryController],
  providers: [
    ImportJobRepository,
    UrlFetchService,
    ContentExtractionService,
    ConfidenceScoringService,
    ImportOrchestrationService,
  ],
  exports: [ImportJobRepository, ImportOrchestrationService],
})
export class DiscoveryModule {}
