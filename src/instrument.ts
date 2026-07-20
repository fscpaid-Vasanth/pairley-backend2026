// Must be imported before any other module (see main.ts) so Sentry can
// instrument the modules it needs to wrap (http, express, prisma, etc.)
// before they're required elsewhere.
import * as Sentry from '@sentry/nestjs';
import { redactSensitive } from './common/utils/redact.util';
import { getRelease } from './common/utils/release.util';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: getRelease(),
    tracesSampleRate: 0.1,
    // We scrub sensitive fields ourselves in beforeSend below, so don't
    // let Sentry attach IPs/cookies/headers by default on top of that.
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        if (event.request.headers) {
          delete event.request.headers['authorization'];
          delete event.request.headers['Authorization'];
          delete event.request.headers['cookie'];
          delete event.request.headers['Cookie'];
        }
        if (event.request.data) {
          event.request.data = redactSensitive(event.request.data);
        }
        if (event.request.cookies) {
          event.request.cookies = undefined;
        }
      }
      if (event.extra) {
        event.extra = redactSensitive(event.extra);
      }
      return event;
    },
  });
}
