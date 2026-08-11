import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OfferModule } from '../offer/offer.module';
import { OfferPublisherModule } from '../offer-publisher/offer-publisher.module';
import { CommonModule } from '../common/common.module';
import { AiOffersFromOnlineController } from './ai-offers-from-online.controller';
import { AiOffersFromOnlineService } from './ai-offers-from-online.service';
import { AiOfferDuplicateDetectionService } from './duplicate-detection.service';

/**
 * "AI Offers From Online" — the Pairley Admin intake queue for the
 * standalone AI Offer Collector (see AiOffersFromOnlineService's class doc
 * for the ownership split). Imports OfferModule for
 * OfferDraftCreationService.matchOrCreateBusiness (merchant matching,
 * reused rather than duplicated) and OfferPublisherModule for
 * OfferPublisherService's approve/publish logic (also reused rather than
 * duplicated — this module never reimplements Pairley's own required-field
 * validation or the DRAFT->APPROVED->ACTIVE transition).
 *
 * Note there is no client for calling back into the Collector: the export
 * arrives complete (approved banner + resolved price), so this backend
 * never needs to reach the Collector for anything.
 *
 * AiOfferDuplicateDetectionService (2026-08-11) is local to this module —
 * it only ever runs against publish()'s own resolved businessId/offer
 * fields, nothing else in the app needs it.
 */
@Module({
  imports: [AuthModule, OfferModule, OfferPublisherModule, CommonModule],
  controllers: [AiOffersFromOnlineController],
  providers: [AiOffersFromOnlineService, AiOfferDuplicateDetectionService],
})
export class AiOffersFromOnlineModule {}
