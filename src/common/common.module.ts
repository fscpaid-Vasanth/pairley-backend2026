import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { OtpService } from './services/otp.service';
import { StorageService } from './services/storage.service';
import { PaymentService } from './services/payment.service';
import { NotificationService } from './services/notification.service';
import { SystemHealthService } from './services/system-health.service';
import { CLOUD_STORAGE_PROVIDER } from './services/storage-providers/cloud-storage-provider.interface';
import { S3StorageProvider } from './services/storage-providers/s3-storage.provider';
import { FirebaseStorageProvider } from './services/storage-providers/firebase-storage.provider';

// Storage Migration Phase 1 — STORAGE_PROVIDER selects which
// CloudStorageProvider StorageService gets, once, at DI-container build
// time. Defaults to 's3' so every existing deployment (nothing sets this
// var yet) keeps its exact current behavior with zero config changes
// required. Setting STORAGE_PROVIDER=firebase on a given environment is
// the entire act of opting that environment into Firebase Storage — no
// code redeploy needed to flip back, just the env var.
const cloudStorageProviderFactory = {
  provide: CLOUD_STORAGE_PROVIDER,
  useFactory: (configService: ConfigService) => {
    const provider = configService.get<string>('STORAGE_PROVIDER', 's3');
    return provider === 'firebase'
      ? new FirebaseStorageProvider(configService)
      : new S3StorageProvider(configService);
  },
  inject: [ConfigService],
};

// Compatibility follow-up to Phase 1 — both concrete providers are always
// registered (not just whichever STORAGE_PROVIDER currently selects),
// specifically so StorageService.getFileByUrl() (the admin document-
// preview proxy's read path) can reach either one directly by URL shape.
// Construction is cheap — neither touches credentials/network until first
// real use (see each provider's lazy init) — so registering both
// unconditionally costs nothing when only one is ever actually read from.
const s3StorageProviderFactory = {
  provide: S3StorageProvider,
  useFactory: (configService: ConfigService) =>
    new S3StorageProvider(configService),
  inject: [ConfigService],
};
const firebaseStorageProviderFactory = {
  provide: FirebaseStorageProvider,
  useFactory: (configService: ConfigService) =>
    new FirebaseStorageProvider(configService),
  inject: [ConfigService],
};

@Global()
@Module({
  imports: [ConfigModule, TerminusModule],
  providers: [
    OtpService,
    cloudStorageProviderFactory,
    s3StorageProviderFactory,
    firebaseStorageProviderFactory,
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
