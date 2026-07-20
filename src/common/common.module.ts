import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { OtpService } from './services/otp.service';
import { StorageService } from './services/storage.service';
import { PaymentService } from './services/payment.service';
import { NotificationService } from './services/notification.service';
import { SystemHealthService } from './services/system-health.service';

@Global()
@Module({
  imports: [ConfigModule, TerminusModule],
  providers: [
    OtpService,
    StorageService,
    PaymentService,
    NotificationService,
    SystemHealthService,
  ],
  exports: [
    OtpService,
    StorageService,
    PaymentService,
    NotificationService,
    SystemHealthService,
  ],
})
export class CommonModule {}
