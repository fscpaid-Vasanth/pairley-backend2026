import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImportJobRepository } from './import-job.repository';
import { UrlFetchService } from './url-fetch.service';
import { ContentExtractionService } from './content-extraction.service';
import { ConfidenceScoringService } from './confidence-scoring.service';
import { CandidateOfferService } from './candidate-offer.service';
import { ImportOrchestrationService } from './import-orchestration.service';
import { ReviewQueueService } from './review-queue.service';
import { DiscoveryController } from './discovery.controller';
import { ReviewQueueController } from './review-queue.controller';

// Module 9 — AI Offer Discovery (Group B). Phase 2 added the website-import
// pipeline; Phase 3 adds the review queue (CandidateOfferService materializes
// a reviewable Business+Offer on import, ReviewQueueService owns the
// approve/reject/takedown state machine + audit trail). The claim-flow
// endpoints (Phase 4) will import this module's exported providers rather
// than duplicating them.
@Module({
  imports: [AuthModule],
  controllers: [DiscoveryController, ReviewQueueController],
  providers: [
    ImportJobRepository,
    UrlFetchService,
    ContentExtractionService,
    ConfidenceScoringService,
    CandidateOfferService,
    ImportOrchestrationService,
    ReviewQueueService,
  ],
  exports: [
    ImportJobRepository,
    ImportOrchestrationService,
    ReviewQueueService,
  ],
})
export class DiscoveryModule {}
