import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OfferService } from './offer.service';
import { OfferController } from './offer.controller';
import { OfferExpiryScheduler } from './offer-expiry.scheduler';
import { OfferDraftCreationService } from './offer-draft-creation.service';
import { AuthModule } from '../auth/auth.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { DiscoveryModule } from '../discovery/discovery.module';

@Module({
  imports: [AuthModule, ScheduleModule.forRoot(), WhatsappModule, DiscoveryModule],
  controllers: [OfferController],
  providers: [OfferService, OfferExpiryScheduler, OfferDraftCreationService],
  exports: [OfferService, OfferDraftCreationService],
})
export class OfferModule {}
