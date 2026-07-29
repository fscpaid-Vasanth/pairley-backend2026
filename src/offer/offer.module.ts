import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OfferService } from './offer.service';
import { OfferController } from './offer.controller';
import { OfferExpiryScheduler } from './offer-expiry.scheduler';
import { BannerRenderService } from './banner-render.service';
import { AuthModule } from '../auth/auth.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [AuthModule, ScheduleModule.forRoot(), WhatsappModule],
  controllers: [OfferController],
  // Module 14 Phase 3B — BannerRenderService is exported so the discovery
  // module can generate a banner at review time. It has no callers on the
  // customer-facing path; banners are produced during admin review, not on
  // request.
  providers: [OfferService, OfferExpiryScheduler, BannerRenderService],
  exports: [OfferService, BannerRenderService],
})
export class OfferModule {}
