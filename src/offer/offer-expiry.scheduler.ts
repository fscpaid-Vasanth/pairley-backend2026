import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OfferService } from './offer.service';

@Injectable()
export class OfferExpiryScheduler {
  private readonly logger = new Logger(OfferExpiryScheduler.name);

  constructor(private readonly offerService: OfferService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleExpiry() {
    const result = await this.offerService.expireOffers();
    if (result.expiredCount > 0) {
      this.logger.log(`Expired ${result.expiredCount} offer(s) past end_date`);
    }
  }
}
