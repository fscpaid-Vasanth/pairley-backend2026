import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OfferService } from './offer.service';
import { OfferController } from './offer.controller';
import { OfferExpiryScheduler } from './offer-expiry.scheduler';
import { BannerRenderService } from './banner-render.service';
import { BannerService } from './banner.service';
import { BannerController } from './banner.controller';
import { ImageAnalysisService } from './image-analysis.service';
import { FileValidationService } from '../discovery/file-validation.service';
import { AuthModule } from '../auth/auth.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [AuthModule, ScheduleModule.forRoot(), WhatsappModule],
  controllers: [OfferController, BannerController],
  // Module 14 Phase 3B — BannerRenderService is exported so the discovery
  // module can generate a banner at review time. It has no callers on the
  // customer-facing path; banners are produced during admin review, not on
  // request.
  providers: [
    OfferService,
    OfferExpiryScheduler,
    BannerRenderService,
    BannerService,
    ImageAnalysisService,
    // Reused from Module 10 rather than re-implemented — the admin hero
    // upload gets the same magic-byte checks as every other upload path.
    FileValidationService,
  ],
  exports: [OfferService, BannerRenderService, BannerService],
})
export class OfferModule {}
