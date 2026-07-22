import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { SentryModule } from '@sentry/nestjs/setup';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { LoggerModule } from 'nestjs-pino';
import { buildLoggerParams } from './common/config/logger.config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { CustomerModule } from './customer/customer.module';
import { BusinessModule } from './business/business.module';
import { OfferModule } from './offer/offer.module';
import { LeadModule } from './lead/lead.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { PaymentModule } from './payment/payment.module';
import { NotificationModule } from './notification/notification.module';
import { SupportModule } from './support/support.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { DiscoveryModule } from './discovery/discovery.module';

@Module({
  imports: [
    SentryModule.forRoot(),
    LoggerModule.forRoot(buildLoggerParams()),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    // Module 12 Phase 1 — registered here so ThrottlerGuard/storage are
    // available for injection wherever a controller opts in via
    // @UseGuards(ThrottlerGuard); deliberately NOT registered as a global
    // APP_GUARD (see claim.controller.ts) — only the two public,
    // unauthenticated claim endpoints throttle today.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 600_000, limit: 20 }]),
    PrismaModule,
    CommonModule,
    AuthModule,
    CustomerModule,
    BusinessModule,
    OfferModule,
    LeadModule,
    SubscriptionModule,
    PaymentModule,
    NotificationModule,
    SupportModule,
    DashboardModule,
    WhatsappModule,
    DiscoveryModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
  ],
})
export class AppModule {}
