import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Params } from 'nestjs-pino';
import { PINO_REDACT_PATHS } from '../utils/redact.util';

// Correlation ID contract: reuse an inbound x-request-id/x-correlation-id
// header if the caller (frontend, uptime monitor, another service) already
// set one, otherwise mint a UUID. Always echoed back on the response so the
// frontend can attach it to its own error reports (see Sentry setup in
// Module 7 Phase 4) and correlate a user-reported issue to these logs.
function getOrCreateRequestId(req: IncomingMessage): string {
  const header = req.headers['x-request-id'] || req.headers['x-correlation-id'];
  const incoming = Array.isArray(header) ? header[0] : header;
  return incoming || randomUUID();
}

export function buildLoggerParams(): Params {
  return {
    pinoHttp: {
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const id = getOrCreateRequestId(req);
        res.setHeader('x-request-id', id);
        return id;
      },
      redact: {
        paths: PINO_REDACT_PATHS,
        censor: '[REDACTED]',
      },
      // The uptime monitor hits /api/health every 5 minutes — logging that
      // as a normal request line would just be noise, not a meaningful event.
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url === '/api/health',
      },
    },
  };
}
