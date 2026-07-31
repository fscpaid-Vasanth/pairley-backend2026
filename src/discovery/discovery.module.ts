import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClaimRequestService } from './claim-request.service';
import { BusinessConsolidationService } from './business-consolidation.service';
import { FileValidationService } from './file-validation.service';
import { ClaimController } from './claim.controller';
import { ClaimAdminController } from './claim-admin.controller';
import { BusinessDuplicatesController } from './business-duplicates.controller';

// Module 9 Phase 4 / Module 12 — the merchant claim and business-
// consolidation flow: request -> admin review -> OTP -> atomic ownership
// transfer (ClaimRequestService), and admin-only duplicate-business
// resolution (BusinessConsolidationService). This module used to also wire
// the AI Offer Discovery pipeline (website/poster/PDF import, OCR,
// normalization, enrichment, duplicate detection, review queue) — removed
// for the bulk-offer-import pivot; see MODULE14_* docs in the repo root for
// what those pieces did. Everything left here predates and is independent
// of that pipeline.
@Module({
  imports: [AuthModule],
  controllers: [
    ClaimController,
    ClaimAdminController,
    BusinessDuplicatesController,
  ],
  providers: [
    ClaimRequestService,
    BusinessConsolidationService,
    FileValidationService,
  ],
  exports: [ClaimRequestService, FileValidationService],
})
export class DiscoveryModule {}
