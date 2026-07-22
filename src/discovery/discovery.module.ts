import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImportJobRepository } from './import-job.repository';
import { UrlFetchService } from './url-fetch.service';
import { ContentExtractionService } from './content-extraction.service';
import { TextExtractionService } from './text-extraction.service';
import { OcrService } from './ocr.service';
import { ConfidenceScoringService } from './confidence-scoring.service';
import { CandidateOfferService } from './candidate-offer.service';
import { NormalizationService } from './normalization.service';
import { DuplicateDetectionService } from './duplicate-detection.service';
import { FileValidationService } from './file-validation.service';
import { PdfTextService } from './pdf-text.service';
import { ImagePreprocessingService } from './image-preprocessing.service';
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
// Module 10 — poster/PDF import. Phase 1 added OcrService/
// TextExtractionService as foundational pieces with no caller yet; Phase 2
// wires them into a real endpoint (FileValidationService, PdfTextService,
// ImagePreprocessingService, and ImportOrchestrationService.importFromFile).
// StorageService (S3 upload) is injected from the @Global() CommonModule,
// not imported here explicitly.
// Module 11 Phase 1 — NormalizationService sits between extraction and
// CandidateOfferService.createCandidate(), deterministically deriving a
// discount split / offer_type / validity end date that plain extraction
// doesn't attempt. No AI/LLM here — that's Phase 3.
// Module 11 Phase 2 — DuplicateDetectionService runs after a candidate is
// created, flagging (never merging/blocking) likely duplicate offers and
// businesses for the admin to review.
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
    NormalizationService,
    DuplicateDetectionService,
    FileValidationService,
    PdfTextService,
    ImagePreprocessingService,
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
