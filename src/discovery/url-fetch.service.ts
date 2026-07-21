import { Injectable, Logger } from '@nestjs/common';
import { isIP } from 'net';
import { promises as dns } from 'dns';
import { isBlockedIp } from './ip-guard.util';

// Carries a machine-readable `reason` alongside the human message, so
// callers (ImportOrchestrationService) can tell a routine/expected failure
// (bad URL, unreachable site, blocked SSRF target) from a genuine bug
// without string-matching the message.
export class UrlFetchError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = 'UrlFetchError';
  }
}

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// The single place this module performs a raw network fetch — every SSRF
// protection required by Module 9 Phase 2 lives here: scheme allowlist,
// pre-connect DNS resolution + IP-range blocking (re-checked on every
// redirect hop, not just the initial URL), a capped redirect count, a
// request timeout, a streamed response-size cap, and a content-type
// allowlist. Known residual risk: DNS-rebinding (a hostname resolving to a
// public IP at validation time and a private one moments later at connect
// time) is not fully closed — doing so requires pinning the resolved
// address into the actual TCP connection, which Node's built-in fetch
// doesn't expose without taking on an extra dependency. Acceptable for a
// v1, admin-only, non-public-facing endpoint; worth revisiting if this
// pipeline is ever exposed more broadly.
@Injectable()
export class UrlFetchService {
  private readonly logger = new Logger(UrlFetchService.name);

  async fetchHtml(rawUrl: string): Promise<{ html: string; finalUrl: string }> {
    let currentUrl = this.parseAndValidateUrl(rawUrl);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await this.assertHostResolvesToPublicIp(currentUrl.hostname);

      let response: Response;
      try {
        response = await fetch(currentUrl.toString(), {
          redirect: 'manual',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { 'User-Agent': 'PairleyOfferImportBot/1.0' },
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new UrlFetchError('Request timed out', 'TIMEOUT');
        }
        throw new UrlFetchError(
          `Network error: ${err instanceof Error ? err.message : 'unknown'}`,
          'NETWORK_ERROR',
        );
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw new UrlFetchError(
            'Redirect response missing Location header',
            'REDIRECT_INVALID',
          );
        }
        if (hop === MAX_REDIRECTS) {
          throw new UrlFetchError('Too many redirects', 'REDIRECT_LIMIT');
        }
        currentUrl = this.parseAndValidateUrl(
          new URL(location, currentUrl).toString(),
        );
        this.logger.debug(
          `Following redirect (hop ${hop + 1}) to ${currentUrl.hostname}`,
        );
        continue;
      }

      if (!response.ok) {
        throw new UrlFetchError(
          `Source returned HTTP ${response.status}`,
          'HTTP_ERROR',
        );
      }

      const contentType = (response.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
        throw new UrlFetchError(
          `Unsupported content type: ${contentType || 'unknown'}`,
          'UNSUPPORTED_CONTENT_TYPE',
        );
      }

      const html = await this.readBodyWithLimit(response);
      return { html, finalUrl: currentUrl.toString() };
    }

    throw new UrlFetchError('Too many redirects', 'REDIRECT_LIMIT');
  }

  private parseAndValidateUrl(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new UrlFetchError('Malformed URL', 'INVALID_URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new UrlFetchError(
        `Unsupported URL scheme: ${url.protocol}`,
        'INVALID_SCHEME',
      );
    }
    if (!url.hostname) {
      throw new UrlFetchError('URL is missing a hostname', 'INVALID_URL');
    }
    return url;
  }

  private async assertHostResolvesToPublicIp(hostname: string): Promise<void> {
    const bareHost = hostname.replace(/^\[|\]$/g, '');

    if (isIP(bareHost)) {
      if (isBlockedIp(bareHost)) {
        throw new UrlFetchError(
          `Blocked target IP: ${bareHost}`,
          'SSRF_BLOCKED',
        );
      }
      return;
    }

    let addresses: { address: string }[];
    try {
      addresses = await dns.lookup(hostname, { all: true });
    } catch {
      throw new UrlFetchError(
        `Could not resolve hostname: ${hostname}`,
        'DNS_ERROR',
      );
    }
    if (addresses.length === 0) {
      throw new UrlFetchError(
        `Hostname resolved to no addresses: ${hostname}`,
        'DNS_ERROR',
      );
    }
    for (const { address } of addresses) {
      if (isBlockedIp(address)) {
        throw new UrlFetchError(
          `Blocked target IP: ${address} (host: ${hostname})`,
          'SSRF_BLOCKED',
        );
      }
    }
  }

  private async readBodyWithLimit(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf-8') > MAX_RESPONSE_BYTES) {
        throw new UrlFetchError(
          'Response exceeded maximum allowed size',
          'RESPONSE_TOO_LARGE',
        );
      }
      return text;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new UrlFetchError(
          'Response exceeded maximum allowed size',
          'RESPONSE_TOO_LARGE',
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
  }
}
