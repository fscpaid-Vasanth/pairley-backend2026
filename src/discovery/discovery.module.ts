import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImportJobRepository } from './import-job.repository';
import { UrlFetchService } from './url-fetch.service';
import { ContentExtractionService } from './content-extraction.service';
import { TextExtractionService } from './text-extraction.service';
import { OcrService } from './ocr.service';
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
// Module 10 Phase 1 — OcrService (tesseract.js behind a clean interface,
// swappable for AWS Textract later without touching any other file) and
// TextExtractionService (ContentExtractionService's plain-text sibling) are
// foundational pieces with no caller yet; the file-upload endpoint that
// wires them into the pipeline lands in Phase 2.
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
    TextExtractionService,
    OcrService,
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
