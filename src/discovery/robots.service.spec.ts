import { RobotsService } from './robots.service';

const originalFetch = global.fetch;

// A Response body can only be read once, so tests that trigger more than
// one fetch must hand back a fresh Response per call — mockResolvedValue
// would reuse a single already-consumed object. Real fetch always returns a
// new one, so this keeps the mock faithful rather than papering over it.
function robotsResponse(body: string, status = 200) {
  return () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'text/plain' },
    });
}

describe('RobotsService (Module 14 Phase 1 — crawl permission)', () => {
  let service: RobotsService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new RobotsService();
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('parse — group selection', () => {
    it('obeys a group naming our product token over the wildcard group', () => {
      const rules = service.parse(`
        User-agent: *
        Disallow: /

        User-agent: PairleyOfferImportBot
        Disallow: /admin
      `);
      expect(rules).toEqual([
        expect.objectContaining({ allow: false, pattern: '/admin' }),
      ]);
    });

    // An explicit empty group for us is a deliberate grant of full access.
    // Falling through to a restrictive `*` group here would invert the site
    // owner's intent — the exact bug this test exists to prevent.
    it('treats an explicit empty group for us as full permission, not a fallthrough', () => {
      const rules = service.parse(`
        User-agent: *
        Disallow: /

        User-agent: PairleyOfferImportBot
        Disallow:
      `);
      expect(rules).toEqual([]);
    });

    it('matches our token case-insensitively', () => {
      const rules = service.parse(`
        User-agent: pairleyofferimportbot
        Disallow: /nope
      `);
      expect(rules).toHaveLength(1);
    });

    it('ignores groups belonging to other crawlers entirely', () => {
      const rules = service.parse(`
        User-agent: Googlebot
        Disallow: /google-only

        User-agent: *
        Disallow: /everyone
      `);
      expect(rules).toEqual([
        expect.objectContaining({ pattern: '/everyone' }),
      ]);
    });

    it('shares one group across consecutive user-agent lines', () => {
      const rules = service.parse(`
        User-agent: Googlebot
        User-agent: PairleyOfferImportBot
        Disallow: /shared
      `);
      expect(rules).toEqual([expect.objectContaining({ pattern: '/shared' })]);
    });

    it('starts a new group when a user-agent line follows a rule line', () => {
      const rules = service.parse(`
        User-agent: *
        Disallow: /first

        User-agent: Googlebot
        Disallow: /second
      `);
      expect(rules).toEqual([expect.objectContaining({ pattern: '/first' })]);
    });

    it('returns null when no group applies to us', () => {
      expect(
        service.parse(`
          User-agent: Googlebot
          Disallow: /
        `),
      ).toBeNull();
    });
  });

  describe('parse — syntax handling', () => {
    it('ignores comments, including trailing ones', () => {
      const rules = service.parse(`
        # a comment line
        User-agent: *   # trailing comment
        Disallow: /secret  # another
      `);
      expect(rules).toEqual([expect.objectContaining({ pattern: '/secret' })]);
    });

    it('ignores non-rule directives without discarding the group', () => {
      const rules = service.parse(`
        User-agent: *
        Crawl-delay: 10
        Sitemap: https://example.com/sitemap.xml
        Disallow: /private
      `);
      expect(rules).toEqual([expect.objectContaining({ pattern: '/private' })]);
    });

    it('ignores rules that appear before any user-agent line', () => {
      const rules = service.parse(`
        Disallow: /orphan
        User-agent: *
        Disallow: /real
      `);
      expect(rules).toEqual([expect.objectContaining({ pattern: '/real' })]);
    });

    it('returns null for an empty file', () => {
      expect(service.parse('')).toBeNull();
    });

    it('survives a garbage file without throwing', () => {
      expect(() =>
        service.parse('<!DOCTYPE html><html><body>404</body></html>'),
      ).not.toThrow();
    });
  });

  describe('isAllowed — path matching', () => {
    function withRobots(body: string, status = 200) {
      fetchMock.mockImplementation(robotsResponse(body, status));
      service.clearCache();
    }

    it('allows a path no rule matches', async () => {
      withRobots('User-agent: *\nDisallow: /admin');
      await expect(service.isAllowed('https://ex.com/offers')).resolves.toEqual(
        { allowed: true },
      );
    });

    it('blocks a path a disallow rule prefixes', async () => {
      withRobots('User-agent: *\nDisallow: /admin');
      const decision = await service.isAllowed('https://ex.com/admin/users');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('ex.com/robots.txt disallows');
    });

    it('blocks everything under a bare "/" disallow', async () => {
      withRobots('User-agent: *\nDisallow: /');
      await expect(
        service.isAllowed('https://ex.com/anything'),
      ).resolves.toMatchObject({ allowed: false });
    });

    it('lets a longer Allow carve an exception out of a broader Disallow', async () => {
      withRobots('User-agent: *\nDisallow: /admin\nAllow: /admin/public');
      await expect(
        service.isAllowed('https://ex.com/admin/public/deal'),
      ).resolves.toEqual({ allowed: true });
      await expect(
        service.isAllowed('https://ex.com/admin/secret'),
      ).resolves.toMatchObject({ allowed: false });
    });

    it('prefers Allow when Allow and Disallow patterns tie on length', async () => {
      withRobots('User-agent: *\nDisallow: /page\nAllow: /page');
      await expect(service.isAllowed('https://ex.com/page')).resolves.toEqual({
        allowed: true,
      });
    });

    it('honours a * wildcard inside a pattern', async () => {
      withRobots('User-agent: *\nDisallow: /*/private');
      await expect(
        service.isAllowed('https://ex.com/shop/private'),
      ).resolves.toMatchObject({ allowed: false });
      await expect(
        service.isAllowed('https://ex.com/shop/public'),
      ).resolves.toEqual({ allowed: true });
    });

    it('honours a trailing $ as an end anchor', async () => {
      withRobots('User-agent: *\nDisallow: /deals$');
      await expect(
        service.isAllowed('https://ex.com/deals'),
      ).resolves.toMatchObject({ allowed: false });
      // Without the anchor this would match as a prefix — it must not.
      await expect(
        service.isAllowed('https://ex.com/deals/summer'),
      ).resolves.toEqual({ allowed: true });
    });

    it('matches against the query string as well as the path', async () => {
      withRobots('User-agent: *\nDisallow: /*?print=1');
      await expect(
        service.isAllowed('https://ex.com/offer?print=1'),
      ).resolves.toMatchObject({ allowed: false });
    });

    // Regex metacharacters in a pattern must be literal, or a rule like
    // `/a+b` would silently match far more than the site owner wrote.
    it('treats regex metacharacters in a pattern as literal text', async () => {
      withRobots('User-agent: *\nDisallow: /a+b');
      await expect(
        service.isAllowed('https://ex.com/a+b'),
      ).resolves.toMatchObject({ allowed: false });
      await expect(service.isAllowed('https://ex.com/aab')).resolves.toEqual({
        allowed: true,
      });
    });
  });

  describe('isAllowed — fetch outcomes', () => {
    it('allows everything when robots.txt is missing (404)', async () => {
      fetchMock.mockImplementation(robotsResponse('', 404));
      await expect(service.isAllowed('https://ex.com/any')).resolves.toEqual({
        allowed: true,
      });
    });

    // RFC 9309 §2.3.1.4 — the server is up and declined to tell us what we
    // may read, which is a "no", not a default-allow.
    it('disallows the whole origin when robots.txt returns a server error', async () => {
      fetchMock.mockImplementation(robotsResponse('', 503));
      const decision = await service.isAllowed('https://ex.com/any');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('503');
    });

    it('allows when robots.txt is unreachable, leaving the real error to the page fetch', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(service.isAllowed('https://ex.com/any')).resolves.toEqual({
        allowed: true,
      });
    });

    it('allows a malformed URL through, since rejecting it is the fetcher’s job', async () => {
      await expect(service.isAllowed('not a url')).resolves.toEqual({
        allowed: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('requests robots.txt from the origin root, under our own User-Agent', async () => {
      fetchMock.mockImplementation(robotsResponse('User-agent: *\nDisallow:'));
      await service.isAllowed('https://ex.com/deep/path?x=1');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://ex.com/robots.txt',
        expect.objectContaining({
          headers: { 'User-Agent': 'PairleyOfferImportBot/1.0' },
        }),
      );
    });
  });

  describe('caching', () => {
    it('fetches robots.txt once per origin across repeated checks', async () => {
      fetchMock.mockImplementation(
        robotsResponse('User-agent: *\nDisallow: /x'),
      );
      await service.isAllowed('https://ex.com/a');
      await service.isAllowed('https://ex.com/b');
      await service.isAllowed('https://ex.com/c');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('caches per origin, not globally', async () => {
      fetchMock.mockImplementation(
        robotsResponse('User-agent: *\nDisallow: /x'),
      );
      await service.isAllowed('https://one.com/a');
      await service.isAllowed('https://two.com/a');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('treats http and https as separate origins', async () => {
      fetchMock.mockImplementation(
        robotsResponse('User-agent: *\nDisallow: /x'),
      );
      await service.isAllowed('http://ex.com/a');
      await service.isAllowed('https://ex.com/a');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
