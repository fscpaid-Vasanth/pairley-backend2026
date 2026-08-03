import { Module } from '@nestjs/common';
import { BusinessService } from './business.service';
import { BusinessController } from './business.controller';
import { AuthModule } from '../auth/auth.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { DiscoveryModule } from '../discovery/discovery.module';

@Module({
  // DiscoveryModule exports FileValidationService — the same magic-byte
  // content check Offer Publisher and claim-evidence uploads already use,
  // now also covering merchant KYC documents (Aadhaar/PAN/GST/shop photo)
  // and media, which previously trusted the client-declared mimetype alone.
  imports: [AuthModule, WhatsappModule, DiscoveryModule],
  controllers: [BusinessController],
  providers: [BusinessService],
  exports: [BusinessService],
})
export class BusinessModule {}
