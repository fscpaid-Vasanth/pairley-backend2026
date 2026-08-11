/**
 * Pure, dependency-free helpers behind AI Offer duplicate detection —
 * source-URL classification/normalization, promotional-mechanic
 * classification, and title similarity. No Prisma, no I/O, so every rule
 * here is directly unit-testable without a mock database.
 */

// ---------------------------------------------------------------------
// Source URL — normalization + "is this actually offer-specific" check.
// ---------------------------------------------------------------------

/** Lowercase host (www.-stripped) + path, query/fragment dropped, trailing slash trimmed. Two URLs that differ only by protocol, tracking params, or a trailing slash normalize identically. */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `${host}${path}`.toLowerCase();
}

const SOCIAL_HOSTS = ['instagram.com', 'facebook.com', 'fb.com', 'twitter.com', 'x.com', 'threads.net'];

const GENERIC_LISTING_SEGMENTS = new Set([
  'offers', 'offer', 'deals', 'deal', 'promotions', 'promotion', 'promo', 'promos',
  'sale', 'sales', 'discounts', 'discount', 'category', 'categories', 'shop', 'store',
  'menu', 'catalog', 'catalogue', 'products', 'product', 'collections', 'collection',
  'gyms', 'restaurants', 'services', 'listing', 'listings', 'home', 'index',
]);

/**
 * Tier 1 duplicate detection may ONLY key off a URL that plausibly points at
 * one specific offer/post — never a merchant's profile, homepage, or a
 * listing/category page, since two DIFFERENT real offers legitimately share
 * those (e.g. two different promos posted to the same Instagram profile).
 *
 * Deliberately biased toward "not offer-specific": any URL shape this
 * doesn't recognize returns false, which routes the caller straight to
 * Tier 2 rather than risking a false HIGH-confidence block.
 */
export function isLikelyOfferSpecificUrl(raw: string | null | undefined): boolean {
  if (!raw?.trim()) return false;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean);
  const lowerSegments = segments.map((s) => s.toLowerCase());

  if (SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    if (host.includes('instagram.com')) {
      // Profile-only (instagram.com/shapesgym) is NOT offer-specific; a
      // single post/reel (/p/<code>, /reel/<code>, /tv/<code>) is.
      return segments.length >= 2 && ['p', 'reel', 'tv'].includes(lowerSegments[0]);
    }
    if (host.includes('facebook.com') || host === 'fb.com') {
      if (lowerSegments.includes('posts') || lowerSegments.includes('photos') || lowerSegments.includes('videos')) {
        return true;
      }
      const isPermalinkPath = ['/permalink.php', '/photo', '/photo.php'].includes(url.pathname);
      if (isPermalinkPath && (url.searchParams.has('story_fbid') || url.searchParams.has('fbid'))) return true;
      return false;
    }
    if (host.includes('twitter.com') || host === 'x.com') {
      return segments.length >= 3 && lowerSegments[1] === 'status';
    }
    if (host.includes('threads.net')) {
      return (segments.length >= 3 && lowerSegments[1] === 'post') || (segments.length >= 2 && lowerSegments[0] === 't');
    }
    return false;
  }

  // Merchant's own site / an aggregator.
  if (segments.length === 0) return false; // bare homepage
  if (segments.length === 1 && GENERIC_LISTING_SEGMENTS.has(lowerSegments[0])) return false; // e.g. /offers, /deals

  const lastSegment = segments[segments.length - 1];
  const hasNumericId = /\d{3,}/.test(lastSegment);
  const hyphenWordCount = lastSegment.split('-').filter(Boolean).length;
  return hasNumericId || hyphenWordCount >= 3;
}

// ---------------------------------------------------------------------
// Promotional mechanic classification.
// ---------------------------------------------------------------------

export type MechanicType = 'FLAT_PRICE' | 'BOGO' | 'BOGT' | 'PERCENTAGE_OFF' | 'FREE_BENEFIT' | 'OTHER';

export interface MechanicSignature {
  type: MechanicType;
  percent: number | null; // PERCENTAGE_OFF only — the stated discount points
  originalPrice: number | null; // FLAT_PRICE only
  offerPrice: number | null; // FLAT_PRICE only
}

// Real listing text rarely says "buy 1 get 1" tightly — "Buy 2 Pairs, Get
// Your 3rd Free" is a typical BOGT phrasing — so both patterns tolerate up
// to ~20 characters of intervening words between "buy <n>" and "get", and
// between "get" and the free/ordinal signal, rather than requiring adjacency.
// BOGT checked first: it requires "2"/"two" right after "buy", which BOGO's
// "1"/"one" requirement never matches, so there's no ordering ambiguity.
const BOGT_PATTERN = /\bbogt\b|buy\s*(?:2|two)\b[\s\S]{0,20}?\bget\b[\s\S]{0,20}?(?:free|third|\d+(?:st|nd|rd|th))/i;
const BOGO_PATTERN = /\bbogo\b|buy\s*(?:1|one)\b[\s\S]{0,15}?\bget\s*(?:1|one)\b/i;
const PERCENT_PATTERN = /(\d{1,3})\s*%/;
const FREE_PATTERN = /\bfree\b/i;

/** text should be the offer's title + description + terms, concatenated. Price-derived FLAT_PRICE takes priority over any text pattern — a real original→offer price pair is a stronger signal than a keyword. */
export function classifyMechanic(
  text: string,
  originalPrice: number | null | undefined,
  offerPrice: number | null | undefined,
): MechanicSignature {
  if (originalPrice != null && offerPrice != null && originalPrice > offerPrice) {
    return { type: 'FLAT_PRICE', percent: null, originalPrice, offerPrice };
  }
  if (BOGT_PATTERN.test(text)) return { type: 'BOGT', percent: null, originalPrice: null, offerPrice: null };
  if (BOGO_PATTERN.test(text)) return { type: 'BOGO', percent: null, originalPrice: null, offerPrice: null };
  const percentMatch = text.match(PERCENT_PATTERN);
  if (percentMatch) {
    const pct = Number(percentMatch[1]);
    if (pct >= 1 && pct <= 99) return { type: 'PERCENTAGE_OFF', percent: pct, originalPrice: null, offerPrice: null };
  }
  if (FREE_PATTERN.test(text)) return { type: 'FREE_BENEFIT', percent: null, originalPrice: null, offerPrice: null };
  return { type: 'OTHER', percent: null, originalPrice: null, offerPrice: null };
}

function relativeDiffPct(a: number, b: number): number {
  const base = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return (Math.abs(a - b) / base) * 100;
}

/** OTHER never equals anything, including another OTHER — a same-business, same-category pair with no recognizable mechanic must never auto-block (Tier 2 simply doesn't fire for it). */
export function mechanicsEqual(a: MechanicSignature, b: MechanicSignature): boolean {
  if (a.type === 'OTHER' || b.type === 'OTHER') return false;
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'FLAT_PRICE': {
      const offerClose = relativeDiffPct(a.offerPrice ?? 0, b.offerPrice ?? 0) <= 2;
      const originalClose =
        a.originalPrice == null || b.originalPrice == null || relativeDiffPct(a.originalPrice, b.originalPrice) <= 2;
      return offerClose && originalClose;
    }
    case 'PERCENTAGE_OFF':
      return Math.abs((a.percent ?? 0) - (b.percent ?? 0)) <= 2;
    default:
      // BOGO / BOGT / FREE_BENEFIT — type equality is the whole signal.
      return true;
  }
}

// ---------------------------------------------------------------------
// Title similarity — normalized token Jaccard, no external dependency.
// ---------------------------------------------------------------------

// Deliberately generic and small — "off"/"get"/"buy"/"free"/"%" are kept
// because they carry the promotional-mechanic signal Tier 2 relies on.
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'and', 'with', 'at', 'in', 'on']);

function tokenize(text: string): Set<string> {
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, ' ');
  const tokens = cleaned
    .split(' ')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t));
  return new Set(tokens);
}

export function titleJaccard(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
