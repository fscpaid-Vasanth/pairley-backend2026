import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OfferService } from './offer.service';
import { OfferController } from './offer.controller';
import { OfferExpiryScheduler } from './offer-expiry.scheduler';
import { AuthModule } from '../auth/auth.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [AuthModule, ScheduleModule.forRoot(), WhatsappModule],
  controllers: [OfferController],
  providers: [OfferService, OfferExpiryScheduler],
  exports: [OfferService],
})
export class OfferModule {}
