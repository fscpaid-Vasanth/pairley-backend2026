import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { AuthModule } from '../auth/auth.module';
import { OfferModule } from '../offer/offer.module';

@Module({
  imports: [AuthModule, OfferModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
