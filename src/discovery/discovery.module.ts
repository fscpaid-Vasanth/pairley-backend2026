import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImportJobRepository } from './import-job.repository';
import { UrlFetchService } from './url-fetch.service';
import { ContentExtractionService } from './content-extraction.service';
import { ConfidenceScoringService } from './confidence-scoring.service';
import { CandidateOfferService } from './candidate-offer.service';
import { ImportOrchestrationService } from './import-orchestration.service';
import { ReviewQueueService } from './review-queue.service';
import { ClaimRequestService } from './claim-request.service';
import { DiscoveryController } from './discovery.controller';
import { ReviewQueueController } from './review-queue.controller';
import { ClaimController } from './claim.controller';
import { ClaimAdminController } from './claim-admin.controller';

// Module 9 — AI Offer Discovery (Group B). Phase 2 added the website-import
// pipeline; Phase 3 added the review queue; Phase 4 adds the admin-assisted
// merchant claim flow (ClaimRequestService owns the request -> admin
// review -> OTP -> atomic ownership transfer state machine).
@Module({
  imports: [AuthModule],
  controllers: [
    DiscoveryController,
    ReviewQueueController,
    ClaimController,
    ClaimAdminController,
  ],
  providers: [
    ImportJobRepository,
    UrlFetchService,
    ContentExtractionService,
    ConfidenceScoringService,
    CandidateOfferService,
    ImportOrchestrationService,
    ReviewQueueService,
    ClaimRequestService,
  ],
  exports: [
    ImportJobRepository,
    ImportOrchestrationService,
    ReviewQueueService,
    ClaimRequestService,
  ],
})
export class DiscoveryModule {}
