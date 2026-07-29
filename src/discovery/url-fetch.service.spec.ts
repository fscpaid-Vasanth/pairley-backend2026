import { UrlFetchService } from './url-fetch.service';
import { RobotsService } from './robots.service';
import { promises as dnsPromises } from 'dns';

jest.mock('dns', () => ({
  promises: { lookup: jest.fn() },
}));

const dns = { lookup: jest.mocked(dnsPromises.lookup) };
const originalFetch = global.fetch;

describe('UrlFetchService (SSRF-safe website fetch)', () => {
  let service: UrlFetchService;
  let fetchMock: jest.Mock;
  let robotsService: { isAllowed: jest.Mock };

  beforeEach(() => {
    // Permissive by default so every pre-existing SSRF/redirect/size
    // assertion below keeps testing exactly what it always did — the
    // robots check is additive, not a new precondition on those paths.
    robotsService = { isAllowed: jest.fn().mockResolvedValue({ allowed: true }) };
    service = new UrlFetchService(robotsService as unknown as RobotsService);
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    dns.lookup.mockReset();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  async function expectReason(promise: Promise<unknown>, reason: string) {
    await expect(promise).rejects.toMatchObject({ reason });
  }

  it('rejects a malformed URL without attempting a network call', async () => {
    await expectReason(service.fetchHtml('not a url'), 'INVALID_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) scheme', async () => {
    await expectReason(
      service.fetchHtml('ftp://example.com/file'),
      'INVALID_SCHEME',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks a direct private-IP literal without a DNS lookup', async () => {
    await expectReason(service.fetchHtml('http://127.0.0.1/'), 'SSRF_BLOCKED');
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks the cloud-metadata IP directly', async () => {
    await expectReason(
      service.fetchHtml('http://169.254.169.254/latest/meta-data/'),
      'SSRF_BLOCKED',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks a hostname that resolves to a private IP', async () => {
    dns.lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expectReason(
      service.fetchHtml('http://internal.example.com/'),
      'SSRF_BLOCKED',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks when any resolved address (of multiple) is private', async () => {
    dns.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ]);
    await expectReason(
      service.fetchHtml('http://mixed.example.com/'),
      'SSRF_BLOCKED',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports DNS resolution failure distinctly', async () => {
    dns.lookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expectReason(
      service.fetchHtml('http://does-not-exist.example/'),
      'DNS_ERROR',
    );
  });

  it('classifies an aborted/timed-out request as TIMEOUT', async () => {
    dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    const timeoutError = new Error('The operation was aborted');
    timeoutError.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeoutError);
    await expectReason(
      service.fetchHtml('http://slow.example.com/'),
      'TIMEOUT',
    );
  });

  it('rejects a non-2xx response', async () => {
    dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await expectReason(
      service.fetchHtml('http://broken.example.com/'),
      'HTTP_ERROR',
    );
  });

  it('rejects an unsupported content type without reading the body further', async () => {
    dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    fetchMock.mockResolvedValue(
      new Response('{"not":"html"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expectReason(
      service.fetchHtml('http://api.example.com/'),
      'UNSUPPORTED_CONTENT_TYPE',
    );
  });

  it('rejects a response exceeding the maximum size', async () => {
    dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    const oversized = 'x'.repeat(3 * 1024 * 1024); // 3MB > 2MB cap
    fetchMock.mockResolvedValue(
      new Response(oversized, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await expectReason(
      service.fetchHtml('http://huge.example.com/'),
      'RESPONSE_TOO_LARGE',
    );
  });

  it('follows a redirect to a safe target and re-validates it before connecting', async () => {
    dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'http://final.example.com/page' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('<title>OK</title>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );

    const result = await service.fetchHtml('http://start.example.com/');
    expect(result.html).toContain('<title>OK</title>');
    expect(result.finalUrl).toBe('http://final.example.com/page');
    expect(dns.lookup).toHaveBeenCalledTimes(2); // validated both hops
  });

  it('blocks a redirect chain that points at a private IP on a later hop', async () => {
    dns.lookup
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]) // first hop: public
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]); // redirect target: blocked
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://internal.example.com/metadata' },
      }),
    );

    await expectReason(
      service.fetchHtml('http://start.example.com/'),
      'SSRF_BLOCKED',
    );
  });

  it('gives up after too many redirects', async () => {
    dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://loop.example.com/' },
      }),
    );
    await expectReason(
      service.fetchHtml('http://loop.example.com/'),
      'REDIRECT_LIMIT',
    );
  });

  it('returns extracted html for a valid, safe, public URL', async () => {
    dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    fetchMock.mockResolvedValue(
      new Response('<html><title>Real Site</title></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    const result = await service.fetchHtml(
      'http://real-merchant.example.com/offer',
    );
    expect(result.html).toContain('Real Site');
    expect(result.finalUrl).toBe('http://real-merchant.example.com/offer');
  });

  describe('robots.txt compliance (Module 14 Phase 1)', () => {
    it('refuses to fetch a page robots.txt disallows, and never requests it', async () => {
      dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
      robotsService.isAllowed.mockResolvedValue({
        allowed: false,
        reason: 'blocked.example.com/robots.txt disallows /private',
      });

      await expectReason(
        service.fetchHtml('http://blocked.example.com/private'),
        'ROBOTS_DISALLOWED',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces the robots reason as the error message, so the admin sees why', async () => {
      dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
      robotsService.isAllowed.mockResolvedValue({
        allowed: false,
        reason: 'shop.example.com/robots.txt disallows /deals',
      });

      await expect(
        service.fetchHtml('http://shop.example.com/deals'),
      ).rejects.toThrow('shop.example.com/robots.txt disallows /deals');
    });

    // The SSRF guard is a security control and robots is a policy one —
    // a blocked host must never receive a request of any kind, including
    // the robots.txt lookup itself.
    it('checks SSRF before robots, so a blocked host is never contacted at all', async () => {
      await expectReason(service.fetchHtml('http://127.0.0.1/'), 'SSRF_BLOCKED');
      expect(robotsService.isAllowed).not.toHaveBeenCalled();
    });

    it('re-checks robots on each redirect hop, since a hop can cross origins', async () => {
      dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
      fetchMock.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'http://elsewhere.example.com/landing' },
        }),
      );
      robotsService.isAllowed
        .mockResolvedValueOnce({ allowed: true })
        .mockResolvedValueOnce({
          allowed: false,
          reason: 'elsewhere.example.com/robots.txt disallows /landing',
        });

      await expectReason(
        service.fetchHtml('http://start.example.com/go'),
        'ROBOTS_DISALLOWED',
      );
      expect(robotsService.isAllowed).toHaveBeenCalledTimes(2);
      // Only the first hop's page request went out; the second was stopped.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('identifies itself honestly via User-Agent on the page request', async () => {
      dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
      fetchMock.mockResolvedValue(
        new Response('<html><title>ok</title></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );

      await service.fetchHtml('http://real.example.com/');
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { 'User-Agent': 'PairleyOfferImportBot/1.0' },
        }),
      );
    });
  });
});
