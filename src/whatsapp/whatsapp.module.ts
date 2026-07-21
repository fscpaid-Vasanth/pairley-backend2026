import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
