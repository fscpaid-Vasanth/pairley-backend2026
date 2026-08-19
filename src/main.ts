import './instrument';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import * as express from 'express';
import type { IncomingMessage } from 'http';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  // Render terminates TLS and proxies every request through exactly one
  // hop before it reaches this process. Without this, Express's req.ip
  // (which ThrottlerGuard keys rate limits on by default) resolves to
  // Render's internal proxy address for every request — identical for
  // every visitor — so the /auth/send-otp limiter silently becomes one
  // shared, site-wide bucket instead of a per-visitor one: once any 3
  // requests land anywhere within a rolling 10-minute window, every other
  // visitor's OTP request is rejected with 429 before it ever reaches
  // OtpService, with no MSG91 call and no MSG91 log entry — exactly the
  // "OTP not received, nothing in MSG91 logs" symptom this fixes.
  // `1` (not `true`) trusts exactly the one real proxy hop Render adds,
  // so a client can't spoof req.ip by prepending a fake address to its
  // own X-Forwarded-For header and evade rate limiting entirely.
  app.set('trust proxy', 1);

  // Increase payload limits for base64 uploads. The `verify` callback
  // stashes the raw request bytes on req.rawBody — needed by the WhatsApp
  // webhook's X-Hub-Signature-256 check, which must HMAC the exact bytes
  // Meta signed, not a re-serialization of the parsed JSON.
  app.use(
    express.json({
      limit: '15mb',
      verify: (req: IncomingMessage & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ limit: '15mb', extended: true }));

  app.enableCors();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
