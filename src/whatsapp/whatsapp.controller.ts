import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Res,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { WhatsappService } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Meta Webhook Verification (GET)
   * Meta calls this endpoint to verify the webhook is valid.
   * It sends: hub.mode, hub.challenge, hub.verify_token
   */
  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.challenge') challenge: string,
    @Query('hub.verify_token') verifyToken: string,
    @Res() res: Response,
  ) {
    const expectedToken = this.configService.get<string>(
      'WHATSAPP_VERIFY_TOKEN',
    );

    this.logger.log(
      `Webhook verification attempt | mode=${mode} | token_match=${verifyToken === expectedToken}`,
    );

    if (mode === 'subscribe' && verifyToken === expectedToken) {
      this.logger.log('✅ WhatsApp Webhook verified successfully');
      return res.status(HttpStatus.OK).send(challenge);
    }

    this.logger.warn('❌ WhatsApp Webhook verification failed - token mismatch');
    return res
      .status(HttpStatus.FORBIDDEN)
      .json({ error: 'Verification failed' });
  }

  /**
   * Meta Webhook Events (POST)
   * Meta sends real-time events here: messages, status updates, etc.
   */
  @Post('webhook')
  async receiveWebhook(@Body() payload: any, @Res() res: Response) {
    try {
      this.logger.log(
        `📨 Incoming WhatsApp event: ${JSON.stringify(payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.type ?? 'unknown')}`,
      );

      await this.whatsappService.handleIncomingEvent(payload);

      // Meta requires a 200 OK response immediately
      return res.status(HttpStatus.OK).json({ status: 'received' });
    } catch (error) {
      this.logger.error('Error processing WhatsApp webhook:', error);
      // Still return 200 to prevent Meta retrying indefinitely
      return res.status(HttpStatus.OK).json({ status: 'error_logged' });
    }
  }
}
