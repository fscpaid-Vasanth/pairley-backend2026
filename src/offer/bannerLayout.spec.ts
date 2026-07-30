import { BusinessStatus, OfferType } from '@prisma/client';
import {
  buildBannerLayout,
  escapeXml,
  truncate,
  formatPrice,
  charsThatFit,
  wrapLines,
  computeDiscountPercent,
  decideBadge,
  decideLogo,
  buildLocation,
  offerTypeLabel,
  BADGE_LABELS,
} from './bannerLayout';

const base = {
  title: 'Weekend Buffet',
  offerType: OfferType.BOGO,
  originalPrice: 1200,
  offerPrice: 600,
  requiredPeople: 2,
  businessName: 'The Big Barbeque',
  businessStatus: BusinessStatus.UNCLAIMED,
  city: 'Chennai',
  source: 'WEBSITE',
};

describe('bannerLayout (Module 14 Phase 3B)', () => {
  describe('escapeXml', () => {
    // Business names come from scraped web pages. An unescaped one would
    // break the SVG at best, and inject markup at worst.
    it('escapes every XML-significant character', () => {
      expect(escapeXml(`Bob & Sons <script> "quoted" 'single'`)).toBe(
        'Bob &amp; Sons &lt;script&gt; &quot;quoted&quot; &apos;single&apos;',
      );
    });

    it('escapes ampersands before anything else, so entities aren’t double-escaped', () => {
      expect(escapeXml('<')).toBe('&lt;');
      expect(escapeXml('&lt;')).toBe('&amp;lt;');
    });

    it('handles null and undefined', () => {
      expect(escapeXml(null as never)).toBe('');
      expect(escapeXml(undefined as never)).toBe('');
    });
  });

  describe('truncate', () => {
    it('leaves short text alone', () => {
      expect(truncate('Weekend Buffet', 40)).toBe('Weekend Buffet');
    });

    it('collapses runs of whitespace and newlines', () => {
      expect(truncate('Weekend   \n  Buffet', 40)).toBe('Weekend Buffet');
    });

    it('breaks on a word boundary when one is close enough', () => {
      const result = truncate('Weekend Buffet Special Offer Today', 20);
      expect(result.endsWith('…')).toBe(true);
      expect(result.length).toBeLessThanOrEqual(20);
      expect(result).not.toMatch(/\s…$/);
    });

    // A long unbroken token has no usable word boundary; it must still fit.
    it('hard-cuts a single very long word', () => {
      const result = truncate('Supercalifragilisticexpialidocious', 15);
      expect(result.length).toBeLessThanOrEqual(15);
      expect(result.endsWith('…')).toBe(true);
    });

    it('never exceeds the limit for any input length', () => {
      for (let n = 1; n < 60; n++) {
        expect(
          truncate('a b c d e f g h i j k l m n o p'.slice(0, n), 12).length,
        ).toBeLessThanOrEqual(12);
      }
    });
  });

  describe('charsThatFit / wrapLines', () => {
    it('fits fewer characters as the font grows', () => {
      expect(charsThatFit(952, 30)).toBeGreaterThan(charsThatFit(952, 60));
    });

    it('never returns zero or negative', () => {
      expect(charsThatFit(10, 200)).toBeGreaterThanOrEqual(1);
      expect(charsThatFit(0, 30)).toBeGreaterThanOrEqual(1);
      expect(charsThatFit(952, 0)).toBeGreaterThanOrEqual(1);
    });

    // The overflow bug this replaced: every produced line must fit.
    it('never emits a line longer than the limit', () => {
      const text =
        'This price applies once 12 customers have shown interest. Add your interest now and the discount becomes available to everyone.';
      [20, 35, 51].forEach((limit) => {
        wrapLines(text, limit, 4).forEach((line) => {
          expect(line.length).toBeLessThanOrEqual(limit);
        });
      });
    });

    it('respects the maximum line count', () => {
      const long = 'word '.repeat(200);
      expect(wrapLines(long, 20, 4).length).toBeLessThanOrEqual(4);
    });

    it('marks the final line when content was dropped', () => {
      const lines = wrapLines('word '.repeat(200), 20, 3);
      expect(lines[lines.length - 1].endsWith('…')).toBe(true);
    });

    it('does not ellipsise when everything fits', () => {
      const lines = wrapLines('short enough text', 40, 4);
      expect(lines).toEqual(['short enough text']);
    });

    it('hard-splits a single word longer than the line', () => {
      const lines = wrapLines('Supercalifragilisticexpialidocious', 10, 4);
      lines.forEach((line) => expect(line.length).toBeLessThanOrEqual(10));
    });

    it('returns an empty array for empty input', () => {
      expect(wrapLines('', 20, 3)).toEqual([]);
      expect(wrapLines('   ', 20, 3)).toEqual([]);
      expect(wrapLines(null as never, 20, 3)).toEqual([]);
    });
  });

  describe('formatPrice', () => {
    it('formats with Indian digit grouping', () => {
      expect(formatPrice(30000)).toBe('₹30,000');
      expect(formatPrice(100000)).toBe('₹1,00,000');
      expect(formatPrice(600)).toBe('₹600');
    });

    it('rounds fractional prices', () => {
      expect(formatPrice(599.6)).toBe('₹600');
    });

    it('renders zero and junk as ₹0 rather than NaN', () => {
      expect(formatPrice(0)).toBe('₹0');
      expect(formatPrice(NaN)).toBe('₹0');
      expect(formatPrice(undefined as never)).toBe('₹0');
    });
  });

  describe('computeDiscountPercent', () => {
    it('computes a genuine discount', () => {
      expect(computeDiscountPercent(1200, 600)).toBe(50);
      expect(computeDiscountPercent(30000, 6000)).toBe(80);
    });

    // Every one of these would otherwise print something false on a public
    // banner — the exact class of bug that damages trust in a marketplace.
    it('returns null when there is no honest discount to claim', () => {
      expect(computeDiscountPercent(0, 0)).toBeNull();
      expect(computeDiscountPercent(null, 600)).toBeNull();
      expect(computeDiscountPercent(600, 600)).toBeNull();
      expect(computeDiscountPercent(600, 900)).toBeNull();
      expect(computeDiscountPercent(undefined, undefined)).toBeNull();
      expect(computeDiscountPercent(NaN, 5)).toBeNull();
    });

    it('suppresses a discount that rounds to zero percent', () => {
      expect(computeDiscountPercent(10000, 9999)).toBeNull();
    });
  });

  describe('decideBadge', () => {
    it('labels an imported offer "Discovered on Pairley", never exclusive', () => {
      const badge = decideBadge({ ...base, source: 'WEBSITE' });
      expect(badge).toBe('DISCOVERED');
      expect(BADGE_LABELS[badge!]).toBe('Discovered on Pairley');
    });

    // The claim would be false: an imported offer is the merchant's own
    // public advertisement, not something given to Pairley exclusively.
    it('refuses EXCLUSIVE on an imported offer even if the flag is set', () => {
      expect(
        decideBadge({ ...base, source: 'POSTER', isPairleyExclusive: true }),
      ).not.toBe('EXCLUSIVE');
    });

    it('honours EXCLUSIVE for a merchant-created offer', () => {
      expect(
        decideBadge({ ...base, source: 'MANUAL', isPairleyExclusive: true }),
      ).toBe('EXCLUSIVE');
    });

    it('prefers verified above everything', () => {
      expect(
        decideBadge({
          ...base,
          merchantVerified: true,
          businessStatus: BusinessStatus.CLAIMED,
        }),
      ).toBe('VERIFIED');
    });

    it('labels a claimed business', () => {
      expect(
        decideBadge({
          ...base,
          source: 'MANUAL',
          businessStatus: BusinessStatus.CLAIMED,
        }),
      ).toBe('CLAIMED');
    });

    it('falls back to curated for a plain merchant-created offer', () => {
      expect(
        decideBadge({
          ...base,
          source: 'MANUAL',
          businessStatus: BusinessStatus.UNCLAIMED,
        }),
      ).toBe('CURATED');
    });
  });

  describe('decideLogo', () => {
    // Using an unclaimed merchant's trademark on a Pairley-branded banner
    // implies an endorsement that does not exist.
    it('withholds the logo for an unclaimed business', () => {
      expect(
        decideLogo({
          ...base,
          businessStatus: BusinessStatus.UNCLAIMED,
          logoUrl: 'https://x/l.png',
        }),
      ).toBeNull();
    });

    it('allows the logo once the business is claimed', () => {
      expect(
        decideLogo({
          ...base,
          businessStatus: BusinessStatus.CLAIMED,
          logoUrl: 'https://x/l.png',
        }),
      ).toBe('https://x/l.png');
    });

    it('returns null when a claimed business has no logo', () => {
      expect(
        decideLogo({ ...base, businessStatus: BusinessStatus.CLAIMED }),
      ).toBeNull();
    });
  });

  describe('buildLocation / offerTypeLabel', () => {
    it('joins mall and city, skipping blanks', () => {
      expect(buildLocation({ ...base, mallName: 'Phoenix Mall' })).toBe(
        'Phoenix Mall, Chennai',
      );
      expect(buildLocation({ ...base, mallName: null })).toBe('Chennai');
      expect(buildLocation({ ...base, city: '  ', mallName: null })).toBe('');
    });

    it('humanises the offer type', () => {
      expect(offerTypeLabel(OfferType.BUY_X_GET_Y)).toBe('Buy X Get Y');
      expect(offerTypeLabel(OfferType.BOGO)).toBe('Bogo');
      expect(offerTypeLabel('')).toBe('Standard');
    });
  });

  describe('buildBannerLayout', () => {
    it('assembles a complete layout', () => {
      const layout = buildBannerLayout(base);
      expect(layout.title).toBe('Weekend Buffet');
      expect(layout.businessName).toBe('The Big Barbeque');
      expect(layout.offerPriceLabel).toBe('₹600');
      expect(layout.originalPriceLabel).toBe('₹1,200');
      expect(layout.discountLabel).toBe('50% OFF');
      expect(layout.savingsLabel).toBe('Save ₹600');
      expect(layout.groupLabel).toBe('2 people needed');
      expect(layout.badgeLabel).toBe('Discovered on Pairley');
      expect(layout.ctaLabel).toBe('Show Interest');
    });

    it('pulls its headline and body from the approved copy catalog', () => {
      const layout = buildBannerLayout(base);
      expect(layout.headline).toMatch(/one seat/i);
      expect(layout.body).toMatch(/another customer/i);
    });

    it('escapes hostile text from a scraped business name', () => {
      const layout = buildBannerLayout({
        ...base,
        businessName: 'Bob & Sons <b>',
        title: 'A "great" deal',
      });
      expect(layout.businessName).toContain('&amp;');
      expect(layout.businessName).toContain('&lt;');
      expect(layout.title).toContain('&quot;');
    });

    it('omits price comparisons rather than inventing them', () => {
      const layout = buildBannerLayout({
        ...base,
        originalPrice: 0,
        offerPrice: 0,
      });
      expect(layout.originalPriceLabel).toBeNull();
      expect(layout.discountLabel).toBeNull();
      expect(layout.savingsLabel).toBeNull();
      expect(layout.offerPriceLabel).toBe('₹0');
    });

    it('omits the group label for a solo offer', () => {
      expect(
        buildBannerLayout({ ...base, requiredPeople: 1 }).groupLabel,
      ).toBeNull();
      expect(
        buildBannerLayout({ ...base, requiredPeople: null }).groupLabel,
      ).toBeNull();
    });

    it('withholds the logo for an unclaimed business end to end', () => {
      expect(
        buildBannerLayout({ ...base, logoUrl: 'https://x/logo.png' }).logoUrl,
      ).toBeNull();
    });

    it('survives an almost-empty offer without throwing', () => {
      const layout = buildBannerLayout({ title: '', offerType: 'STANDARD' });
      expect(layout.title).toBe('Special Offer');
      expect(layout.businessName).toBe('Local Business');
      expect(layout.offerPriceLabel).toBe('₹0');
      expect(layout.body.length).toBeGreaterThan(0);
    });

    it('never emits a raw angle bracket into any text field', () => {
      const layout = buildBannerLayout({
        ...base,
        title: '<img src=x onerror=alert(1)>',
        businessName: '</text><script>',
        city: '<b>Chennai</b>',
      });
      [
        layout.title,
        layout.businessName,
        layout.location,
        layout.body,
        layout.headline,
      ].forEach((field) => {
        expect(field).not.toMatch(/[<>]/);
      });
    });

    // Module 14 Phase 3C follow-up — Template F content, computed inline
    // rather than requiring a second call. The underlying math/wording
    // logic is covered exhaustively in costSplitBanner.spec.ts; these
    // confirm buildBannerLayout actually wires it through.
    describe('Template F content', () => {
      it('includes the group-savings figures when the offer genuinely saves', () => {
        const layout = buildBannerLayout({ ...base, templateId: 'F' });
        expect(layout.costSplit).toEqual({
          actualPriceLabel: '₹1,200',
          yourShareLabel: '₹600',
          yourSavingLabel: '₹600',
          groupSavingLabel: '₹1,200',
          groupSavingLead: 'You Both Save',
          groupSavingWorking: '2 × ₹600',
        });
      });

      it('omits the cost split when there is nothing honest to show, regardless of template', () => {
        const layout = buildBannerLayout({
          ...base,
          templateId: 'F',
          originalPrice: 500,
          offerPrice: 500,
        });
        expect(layout.costSplit).toBeNull();
      });

      it('always provides exactly 3 unlock steps', () => {
        expect(
          buildBannerLayout({ ...base, templateId: 'F' }).unlockSteps,
        ).toHaveLength(3);
      });

      it('withholds "Verified Local Partner" for an unclaimed business', () => {
        const layout = buildBannerLayout({ ...base, templateId: 'F' });
        expect(layout.whyBullets).not.toContain('Verified Local Partner');
      });

      it('builds a deal URL only when an offer id is given', () => {
        expect(
          buildBannerLayout({ ...base, templateId: 'F' }).dealUrl,
        ).toBeNull();
        expect(
          buildBannerLayout({ ...base, templateId: 'F', offerId: 'offer-1' })
            .dealUrl,
        ).toBe('https://pairley.com/deals/offer-1');
      });

      it('never fabricates a rating — omits it with no rating data', () => {
        expect(
          buildBannerLayout({ ...base, templateId: 'F' }).businessRatingLabel,
        ).toBeNull();
      });

      it('formats a genuine rating, abbreviating large review counts', () => {
        const layout = buildBannerLayout({
          ...base,
          templateId: 'F',
          businessRating: { average: 4.6, count: 1234 },
        });
        expect(layout.businessRatingLabel).toBe('4.6 (1.2K+ reviews)');
      });

      it('uses the singular "review" for exactly one rating', () => {
        const layout = buildBannerLayout({
          ...base,
          templateId: 'F',
          businessRating: { average: 5, count: 1 },
        });
        expect(layout.businessRatingLabel).toBe('5.0 (1 review)');
      });
    });

    describe('per-template canvas size', () => {
      it('renders A-E on the shared square canvas', () => {
        ['A', 'B', 'C', 'D', 'E'].forEach((templateId) => {
          const layout = buildBannerLayout({ ...base, templateId });
          expect(layout.width).toBe(1080);
          expect(layout.height).toBe(1080);
        });
      });

      it('renders F on a landscape canvas, matching its richer content', () => {
        const layout = buildBannerLayout({ ...base, templateId: 'F' });
        expect(layout.width).toBe(1200);
        expect(layout.height).toBe(900);
        expect(layout.width).toBeGreaterThan(layout.height);
      });
    });
  });
});
