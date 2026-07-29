import { Injectable, Logger } from '@nestjs/common';

// The product token this crawler answers to in robots.txt. Deliberately the
// bare token, not the full User-Agent string — robots.txt matching is done
// against the product token only (RFC 9309 §2.2.1), so a site owner writes
// `User-agent: PairleyOfferImportBot` without a version suffix and the rule
// keeps applying when our version changes.
export const CRAWLER_PRODUCT_TOKEN = 'PairleyOfferImportBot';
export const CRAWLER_USER_AGENT = `${CRAWLER_PRODUCT_TOKEN}/1.0`;

const ROBOTS_FETCH_TIMEOUT_MS = 5_000;
const MAX_ROBOTS_BYTES = 512 * 1024; // robots.txt files are tiny; 512KB is generous
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface RobotsRule {
  allow: boolean;
  // The raw path pattern as written in robots.txt. Kept alongside the
  // compiled regex because rule specificity is decided by the pattern's
  // character length, not by anything the regex knows about.
  pattern: string;
  regex: RegExp;
}

interface RobotsPolicy {
  // null means "no applicable rules" — an empty or absent robots.txt, or one
  // with no group matching us and no `*` group. Everything is allowed.
  rules: RobotsRule[] | null;
  // Set when the whole origin is disallowed without parsing rules — an
  // unreachable robots.txt (5xx), which RFC 9309 §2.3.1.4 says to treat as
  // a complete disallow rather than as permission.
  blanketDisallowReason?: string;
}

export interface RobotsDecision {
  allowed: boolean;
  /** Present only when allowed is false — safe to surface to an admin. */
  reason?: string;
}

/**
 * robots.txt compliance for the discovery crawler (Module 14 Phase 1).
 *
 * This is a policy check, not a security control — the SSRF/size/redirect
 * protections in UrlFetchService are what keep the fetch *safe*. This is
 * what keeps it *permitted*: it exists so Pairley only ever reads pages the
 * site owner has published as crawlable, per the module's compliance rule
 * that we process publicly accessible content and respect the source's
 * terms rather than working around them.
 *
 * Deliberately no third-party robots parser — the rule set we need is small
 * and well specified (RFC 9309), and a hand-written parser we can unit-test
 * against real-world edge cases beats an opaque dependency for something
 * this consequential.
 */
@Injectable()
export class RobotsService {
  private readonly logger = new Logger(RobotsService.name);

  // Keyed by origin. Kept in-process and short-lived: a single import run
  // typically hits one origin several times (initial URL plus redirect
  // hops), and re-fetching robots.txt for each hop would be both slow and
  // needlessly noisy for the site owner.
  private readonly cache = new Map<
    string,
    { policy: RobotsPolicy; expiresAt: number }
  >();

  async isAllowed(rawUrl: string): Promise<RobotsDecision> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      // Malformed URLs are UrlFetchService's business to reject with its own
      // INVALID_URL reason — not something to mask behind a robots verdict.
      return { allowed: true };
    }

    const policy = await this.getPolicy(url.origin);

    if (policy.blanketDisallowReason) {
      return { allowed: false, reason: policy.blanketDisallowReason };
    }
    if (!policy.rules || policy.rules.length === 0) {
      return { allowed: true };
    }

    const path = `${url.pathname}${url.search}` || '/';
    const match = this.findMostSpecificRule(policy.rules, path);

    if (!match || match.allow) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `${url.hostname}/robots.txt disallows ${path} for ${CRAWLER_PRODUCT_TOKEN}`,
    };
  }

  /** Test seam — lets specs exercise parsing without a network round trip. */
  clearCache(): void {
    this.cache.clear();
  }

  private async getPolicy(origin: string): Promise<RobotsPolicy> {
    const cached = this.cache.get(origin);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.policy;
    }

    const policy = await this.fetchPolicy(origin);
    this.cache.set(origin, { policy, expiresAt: Date.now() + CACHE_TTL_MS });
    return policy;
  }

  private async fetchPolicy(origin: string): Promise<RobotsPolicy> {
    let response: Response;
    try {
      response = await fetch(`${origin}/robots.txt`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': CRAWLER_USER_AGENT },
      });
    } catch {
      // Couldn't reach robots.txt at all. Not treated as a disallow: if the
      // host is genuinely unreachable the page fetch that follows will fail
      // on its own and report a truthful network error, which is a far more
      // useful message to an admin than a robots verdict that isn't really
      // about robots.
      this.logger.debug(`robots.txt unreachable for ${origin} — allowing`);
      return { rules: null };
    }

    // RFC 9309 §2.3.1.4: a server error means the crawler must assume the
    // whole site is disallowed. This is the one case where being unable to
    // read the policy is itself a "no" — the site is up enough to answer,
    // and it declined to tell us what we may read.
    if (response.status >= 500) {
      return {
        rules: null,
        blanketDisallowReason: `${new URL(origin).hostname}/robots.txt returned HTTP ${response.status}, so crawling is treated as disallowed`,
      };
    }

    // 4xx (including the very common 404) means no robots.txt exists, which
    // is full permission — the standard's explicit default.
    if (!response.ok) {
      return { rules: null };
    }

    const body = await this.readCapped(response);
    if (body === null) {
      this.logger.warn(`robots.txt for ${origin} exceeded size cap — allowing`);
      return { rules: null };
    }

    return { rules: this.parse(body) };
  }

  private async readCapped(response: Response): Promise<string | null> {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf-8') > MAX_ROBOTS_BYTES) {
      return null;
    }
    return text;
  }

  /**
   * Returns the rules of the single most specific group that applies to us:
   * a group naming our product token if one exists, otherwise the `*` group.
   * Groups for other crawlers are ignored entirely — per the standard, a
   * crawler obeys exactly one group, never a union of them.
   */
  parse(body: string): RobotsRule[] | null {
    const ourGroup: RobotsRule[] = [];
    const wildcardGroup: RobotsRule[] = [];
    let matchedOurToken = false;

    // Agents named by the group currently being read. Consecutive
    // `User-agent:` lines with no rule between them form one shared group.
    let currentAgents: string[] = [];
    let expectingAgents = true;

    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.split('#')[0].trim();
      if (!line) continue;

      const separator = line.indexOf(':');
      if (separator === -1) continue;

      const field = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();

      if (field === 'user-agent') {
        // A user-agent line following a rule line starts a brand new group
        // rather than adding to the one we just finished reading.
        if (!expectingAgents) {
          currentAgents = [];
          expectingAgents = true;
        }
        currentAgents.push(value.toLowerCase());
        continue;
      }

      if (field !== 'allow' && field !== 'disallow') {
        // Sitemap, Crawl-delay, Host, and anything non-standard. Not our
        // concern here, and explicitly not a reason to discard the group.
        continue;
      }

      expectingAgents = false;
      if (currentAgents.length === 0) continue;

      const targetsUs = currentAgents.includes(
        CRAWLER_PRODUCT_TOKEN.toLowerCase(),
      );
      const targetsWildcard = currentAgents.includes('*');
      if (!targetsUs && !targetsWildcard) continue;

      // `Disallow:` with an empty value is the documented way to say "allow
      // everything" — it is the absence of a restriction, not a rule
      // matching the empty path, so it must not become a rule at all.
      // `Allow:` with an empty value is meaningless for the same reason.
      if (value === '') {
        if (targetsUs) matchedOurToken = true;
        continue;
      }

      const rule: RobotsRule = {
        allow: field === 'allow',
        pattern: value,
        regex: this.compilePattern(value),
      };

      if (targetsUs) {
        matchedOurToken = true;
        ourGroup.push(rule);
      } else if (targetsWildcard) {
        wildcardGroup.push(rule);
      }
    }

    // A group naming us always wins, even if it is empty — an explicit
    // `User-agent: PairleyOfferImportBot` / `Disallow:` pair is a
    // deliberate grant of full access and must not fall through to a
    // restrictive `*` group.
    if (matchedOurToken) return ourGroup;
    if (wildcardGroup.length > 0) return wildcardGroup;
    return null;
  }

  /**
   * robots.txt patterns are prefix matches with two special characters:
   * `*` matches any run of characters, and a trailing `$` anchors the end.
   * Everything else is literal — including characters that are meaningful
   * in a regex, hence the escaping.
   */
  private compilePattern(pattern: string): RegExp {
    const anchoredAtEnd = pattern.endsWith('$');
    const body = anchoredAtEnd ? pattern.slice(0, -1) : pattern;

    const source = body
      .split('*')
      .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');

    return new RegExp(`^${source}${anchoredAtEnd ? '$' : ''}`);
  }

  /**
   * Longest matching pattern wins; on an equal-length tie, Allow beats
   * Disallow. Both rules come straight from the standard and exist so a
   * site can carve an exception out of a broad block
   * (`Disallow: /admin` + `Allow: /admin/public`) and have it actually work.
   */
  private findMostSpecificRule(
    rules: RobotsRule[],
    path: string,
  ): RobotsRule | null {
    let best: RobotsRule | null = null;

    for (const rule of rules) {
      if (!rule.regex.test(path)) continue;
      if (!best) {
        best = rule;
        continue;
      }
      if (rule.pattern.length > best.pattern.length) {
        best = rule;
      } else if (rule.pattern.length === best.pattern.length && rule.allow) {
        best = rule;
      }
    }

    return best;
  }
}
