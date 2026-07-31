import './instrument';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import * as express from 'express';
import type { IncomingMessage } from 'http';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

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
