import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { CustomerModule } from './customer/customer.module';
import { BusinessModule } from './business/business.module';
import { OfferModule } from './offer/offer.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { PaymentModule } from './payment/payment.module';
import { NotificationModule } from './notification/notification.module';
import { SupportModule } from './support/support.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    CommonModule,
    AuthModule,
    CustomerModule,
    BusinessModule,
    OfferModule,
    SubscriptionModule,
    PaymentModule,
    NotificationModule,
    SupportModule,
    DashboardModule,
    WhatsappModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
