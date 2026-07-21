import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Req,
  Res,
  HttpStatus,
  Logger,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { WhatsappService } from './whatsapp.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles, Role } from '../common/decorators/roles.decorator';

@Controller('whatsapp')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(
    private readonly whatsappService: WhatsappService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // HEALTH CHECK — env-check details, admin-only since it reveals
  // whether secrets are configured (length only, never the value)
  // GET /api/whatsapp/health
  // ─────────────────────────────────────────────────────────────
  @Get('health')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  healthCheck(@Res() res: Response) {
    const verifyToken = this.configService.get<string>('WHATSAPP_VERIFY_TOKEN');
    const phoneId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const apiToken = this.configService.get<string>('WHATSAPP_API_TOKEN');

    return res.status(HttpStatus.OK).json({
      status: 'WhatsApp Webhook Service is running',
      timestamp: new Date().toISOString(),
      env_check: {
        WHATSAPP_VERIFY_TOKEN: verifyToken
          ? `✅ Set (${verifyToken.length} chars, starts: "${verifyToken.slice(0, 5)}...")`
          : '❌ NOT SET',
        WHATSAPP_PHONE_NUMBER_ID: phoneId
          ? `✅ Set (${phoneId})`
          : '❌ NOT SET',
        WHATSAPP_API_TOKEN: apiToken
          ? `✅ Set (${apiToken.length} chars)`
          : '❌ NOT SET',
      },
      webhook_url:
        'https://pairley-backend2026.onrender.com/api/whatsapp/webhook',
    });
  }

  // ─────────────────────────────────────────────────────────────
  // WEBHOOK VERIFICATION — Meta calls this to verify the endpoint
  // GET /api/whatsapp/webhook
  // ─────────────────────────────────────────────────────────────
  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.challenge') challenge: string,
    @Query('hub.verify_token') verifyToken: string,
    @Res() res: Response,
  ) {
    // ── Load the expected token from environment ──────────────
    const expectedToken =
      this.configService.get<string>('WHATSAPP_VERIFY_TOKEN') ||
      process.env.WHATSAPP_VERIFY_TOKEN; // direct fallback in case ConfigService misses

    // ── Full debug log (safe — only logs token length, not value) ──
    this.logger.log('═══════════════ WEBHOOK VERIFICATION ═══════════════');
    this.logger.log(`  hub.mode          : "${mode}"`);
    this.logger.log(`  hub.challenge     : "${challenge}"`);
    this.logger.log(`  received token    : "${verifyToken}"`);
    this.logger.log(`  expected token    : "${expectedToken}"`);
    this.logger.log(`  token match       : ${verifyToken === expectedToken}`);
    this.logger.log(`  env var loaded    : ${!!expectedToken}`);
    this.logger.log('═══════════════════════════════════════════════════');

    // ── Guard: env var must be configured ────────────────────
    if (!expectedToken) {
      this.logger.error('❌ WHATSAPP_VERIFY_TOKEN is not set in environment!');
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: 'Server misconfiguration: verify token not set',
      });
    }

    // ── Meta verification handshake ──────────────────────────
    if (mode === 'subscribe' && verifyToken === expectedToken) {
      this.logger.log('✅ Webhook VERIFIED — returning challenge to Meta');
      // CRITICAL: Must return plain text challenge (not JSON)
      return res
        .status(HttpStatus.OK)
        .set('Content-Type', 'text/plain')
        .send(challenge);
    }

    // ── Failure cases ─────────────────────────────────────────
    if (mode !== 'subscribe') {
      this.logger.warn(
        `❌ Verification failed — hub.mode is "${mode}", expected "subscribe"`,
      );
    } else {
      this.logger.warn('❌ Verification failed — verify token MISMATCH');
      this.logger.warn(`   Received : "${verifyToken}"`);
      this.logger.warn(`   Expected : "${expectedToken}"`);
    }

    return res.status(HttpStatus.FORBIDDEN).json({
      error: 'Verification failed',
      reason:
        mode !== 'subscribe'
          ? `hub.mode must be "subscribe", got "${mode}"`
          : 'verify token does not match',
    });
  }

  // Verifies Meta's X-Hub-Signature-256 header: HMAC-SHA256 of the raw
  // request body, keyed with the app secret. Must run over the exact bytes
  // Meta signed (req.rawBody, captured in main.ts's express.json `verify`
  // callback) — HMACing a re-serialization of the parsed JSON body would
  // not reliably match. Fails open (logs, doesn't reject) when
  // WHATSAPP_APP_SECRET isn't configured, so this doesn't take the live
  // webhook down before that env var is added — see MONITORING_SETUP.md.
  private isValidSignature(req: Request): boolean {
    const appSecret = this.configService.get<string>('WHATSAPP_APP_SECRET');
    if (!appSecret) {
      this.logger.warn(
        'WHATSAPP_APP_SECRET not configured — skipping webhook signature verification (fail-open)',
      );
      return true;
    }

    const signatureHeader = req.headers['x-hub-signature-256'];
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (typeof signatureHeader !== 'string' || !rawBody) {
      this.logger.warn(
        'Webhook POST missing signature header or raw body — rejecting',
      );
      return false;
    }

    const expected =
      'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(signatureHeader);
    if (expectedBuf.length !== receivedBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, receivedBuf);
  }

  // ─────────────────────────────────────────────────────────────
  // WEBHOOK EVENTS — Meta posts all real-time events here
  // POST /api/whatsapp/webhook
  // ─────────────────────────────────────────────────────────────
  @Post('webhook')
  async receiveWebhook(
    @Body() payload: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!this.isValidSignature(req)) {
      res.status(HttpStatus.FORBIDDEN).json({ error: 'Invalid signature' });
      return;
    }

    // ── Immediately respond 200 — Meta requires fast ACK ─────
    // If we don't respond within 20 seconds, Meta retries
    res.status(HttpStatus.OK).json({ status: 'received' });

    // ── Process event asynchronously after responding ─────────
    try {
      const entry = payload?.entry?.[0];
      const change = entry?.changes?.[0];
      const messages = change?.value?.messages;
      const statuses = change?.value?.statuses;

      this.logger.log('═══════════════ INCOMING WEBHOOK ═══════════════');
      this.logger.log(`  object   : ${payload?.object}`);
      this.logger.log(`  messages : ${messages?.length ?? 0}`);
      this.logger.log(`  statuses : ${statuses?.length ?? 0}`);
      if (messages?.[0]) {
        this.logger.log(`  from     : ${messages[0].from}`);
        this.logger.log(`  type     : ${messages[0].type}`);
        this.logger.log(`  text     : ${messages[0].text?.body ?? 'N/A'}`);
      }
      this.logger.log('════════════════════════════════════════════════');

      await this.whatsappService.handleIncomingEvent(payload);
    } catch (error) {
      this.logger.error('Error processing WhatsApp webhook event:', error);
    }
  }
}
