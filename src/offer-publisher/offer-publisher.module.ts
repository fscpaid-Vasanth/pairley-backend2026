import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OfferModule } from '../offer/offer.module';
import { FileValidationService } from '../discovery/file-validation.service';
import { OfferPublisherController } from './offer-publisher.controller';
import { OfferPublisherService } from './offer-publisher.service';

@Module({
  imports: [AuthModule, OfferModule],
  controllers: [OfferPublisherController],
  providers: [
    OfferPublisherService,
    // Reused from Module 10/12's upload path — the same magic-byte checks
    // apply to an Offer Publisher image as to any other upload.
    FileValidationService,
  ],
  // OfferPublisherService exported so AiOffersFromOnlineModule (2026-08-09) can
  // delegate to its approveDraft/publishDraft rather than reimplementing
  // Pairley's own required-field validation and DRAFT->APPROVED->ACTIVE
  // transition a second time.
  exports: [OfferPublisherService],
})
export class OfferPublisherModule {}
