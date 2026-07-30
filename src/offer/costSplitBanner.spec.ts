import { BusinessStatus } from '@prisma/client';
import {
  computeCostSplit,
  isCostSplitEligible,
  buildUnlockSteps,
  buildWhyPairleyBullets,
  buildDealUrl,
  buildDiscountBadgeText,
} from './costSplitBanner';

describe('costSplitBanner (Module 14 Phase 3C follow-up — Template F)', () => {
  describe('computeCostSplit', () => {
    it('computes the reference-design numbers (₹698 -> ₹349, saving ₹349)', () => {
      const result = computeCostSplit(698, 349, 2);
      expect(result).toEqual({
        actualPriceLabel: '₹698',
        yourShareLabel: '₹349',
        yourSavingLabel: '₹349',
        groupSavingLabel: '₹698',
        groupSavingLead: 'You Both Save',
        groupSavingWorking: '2 × ₹349',
      });
    });

    // The bug this replaced: the box used to read `original - offer` as
    // "what the other participants pay between them". That is the PER-PERSON
    // SAVING (DealCard shows the identical figure as "Save ₹X"), and the
    // mislabelling only looks right at exactly 50% off with exactly 2 people
    // — i.e. every BOGO, which is why it passed review. These are the cases
    // where the old framing was flatly false.
    it('states the real group saving for a large group, not the per-person delta', () => {
      // Live production offer: ₹10,000 -> ₹5,000 for 50 people.
      const result = computeCostSplit(10000, 5000, 50);
      expect(result?.yourShareLabel).toBe('₹5,000');
      expect(result?.yourSavingLabel).toBe('₹5,000');
      // 50 × ₹5,000 — NOT ₹10,000, which is what the old "total" claimed.
      expect(result?.groupSavingLabel).toBe('₹2,50,000');
      expect(result?.groupSavingWorking).toBe('50 × ₹5,000');
    });

    it('never presents a group total equal to the struck-through price', () => {
      // The old box struck through ₹10,000 and then celebrated ₹10,000 as
      // the group total, arguing the deal saved nothing.
      const result = computeCostSplit(10000, 8000, 10);
      expect(result?.actualPriceLabel).toBe('₹10,000');
      expect(result?.groupSavingLabel).not.toBe(result?.actualPriceLabel);
      expect(result?.groupSavingLabel).toBe('₹20,000'); // 10 × ₹2,000
    });

    it('prints the arithmetic so the headline group figure is checkable', () => {
      const result = computeCostSplit(3000, 1000, 5);
      expect(result?.groupSavingWorking).toBe('5 × ₹2,000');
      expect(result?.groupSavingLabel).toBe('₹10,000');
    });

    // "Both" is only grammatically correct for exactly 2 participants.
    it('says "You Both Save" for a pair and "You All Save" for larger groups', () => {
      expect(computeCostSplit(698, 349, 2)?.groupSavingLead).toBe(
        'You Both Save',
      );
      expect(computeCostSplit(5000, 1000, 5)?.groupSavingLead).toBe(
        'You All Save',
      );
    });

    // Every figure is quoted from the offer or one multiplication away from
    // it; each rejection below is a case where a figure would be fabricated,
    // degenerate, or misleading.
    it('is null with no genuine original price', () => {
      expect(computeCostSplit(0, 349, 2)).toBeNull();
      expect(computeCostSplit(null, 349, 2)).toBeNull();
      expect(computeCostSplit(undefined, 349, 2)).toBeNull();
    });

    it('is null when the offer price is not actually lower', () => {
      expect(computeCostSplit(500, 500, 2)).toBeNull();
      expect(computeCostSplit(500, 600, 2)).toBeNull();
    });

    it('is null when fewer than 2 people are required — there is no group', () => {
      expect(computeCostSplit(698, 349, 1)).toBeNull();
      expect(computeCostSplit(698, 349, 0)).toBeNull();
      expect(computeCostSplit(698, 349, null)).toBeNull();
    });

    // A 1% discount is not a "cost split" — it belongs on the ordinary
    // discount chip, not this box's specific savings claim.
    it('is null when one side of the split would be a rounding-error sliver', () => {
      expect(computeCostSplit(1000, 990, 2)).toBeNull();
      expect(computeCostSplit(1000, 10, 2)).toBeNull();
    });

    it('accepts an uneven but still genuine split', () => {
      expect(computeCostSplit(1000, 300, 2)).not.toBeNull();
      expect(computeCostSplit(1000, 700, 2)).not.toBeNull();
    });

    it('handles junk input without throwing', () => {
      expect(() => computeCostSplit(NaN, NaN, NaN)).not.toThrow();
      expect(computeCostSplit(NaN, 349, 2)).toBeNull();
    });
  });

  describe('buildDiscountBadgeText', () => {
    it('captions the discount figure as a saving', () => {
      expect(buildDiscountBadgeText('20% OFF')).toEqual({
        caption: 'YOU SAVE',
        value: '20%',
      });
    });

    // The caption sits directly above a DISCOUNT percentage. Any wording
    // that describes the figure as the portion paid inverts the claim for
    // every discount except exactly 50%.
    it('never describes the discount figure as the amount paid', () => {
      ['5% OFF', '20% OFF', '50% OFF', '80% OFF'].forEach((label) => {
        const badge = buildDiscountBadgeText(label);
        expect(badge?.caption).not.toMatch(/pay/i);
        expect(badge?.caption).toMatch(/save/i);
      });
    });

    it('is null when there is no discount to state', () => {
      expect(buildDiscountBadgeText(null)).toBeNull();
      expect(buildDiscountBadgeText(undefined)).toBeNull();
      expect(buildDiscountBadgeText('')).toBeNull();
      expect(buildDiscountBadgeText('   ')).toBeNull();
    });
  });

  describe('isCostSplitEligible', () => {
    it('mirrors computeCostSplit', () => {
      expect(isCostSplitEligible(698, 349, 2)).toBe(true);
      expect(isCostSplitEligible(500, 500, 2)).toBe(false);
    });
  });

  describe('buildUnlockSteps', () => {
    it('always returns exactly 3 steps', () => {
      expect(buildUnlockSteps(2)).toHaveLength(3);
      expect(buildUnlockSteps(5)).toHaveLength(3);
      expect(buildUnlockSteps(null)).toHaveLength(3);
    });

    it('uses singular "Offer Partner" phrasing for a 2-person group', () => {
      const steps = buildUnlockSteps(2);
      expect(steps[1].title).toBe('Offer Partner Does Too');
      expect(steps[1].body).toContain('one more person');
    });

    it('uses plural phrasing for a larger group', () => {
      const steps = buildUnlockSteps(5);
      expect(steps[1].title).toBe('Others Join Too');
      expect(steps[1].body).toContain('4 more people');
    });

    // The load-bearing rule carried over from pairleyCopyTemplates.ts: state
    // the condition, never promise the group completes.
    it('never promises the group will complete', () => {
      const FORBIDDEN = [
        /\bwe will find\b/i,
        /\bguarantee/i,
        /\bwill be matched\b/i,
      ];
      [2, 3, 5, 10].forEach((n) => {
        buildUnlockSteps(n).forEach((step) => {
          FORBIDDEN.forEach((pattern) => {
            expect(`${step.title} ${step.body}`).not.toMatch(pattern);
          });
        });
      });
    });

    it('defaults to a 2-person framing for missing/invalid input', () => {
      expect(buildUnlockSteps(undefined)[1].title).toBe(
        'Offer Partner Does Too',
      );
      expect(buildUnlockSteps(0)[1].title).toBe('Offer Partner Does Too');
      expect(buildUnlockSteps(-3)[1].title).toBe('Offer Partner Does Too');
    });
  });

  describe('buildWhyPairleyBullets', () => {
    it('shows only brand-level bullets for an unclaimed business', () => {
      const bullets = buildWhyPairleyBullets(BusinessStatus.UNCLAIMED, false);
      expect(bullets).not.toContain('Verified Local Partner');
      expect(bullets).toContain('Better Deals Together');
    });

    // Claiming a trust relationship with a business that hasn't joined
    // Pairley yet would be exactly the overclaim Phase 3B's badge rules
    // already refuse to make.
    it('adds "Verified Local Partner" only for a claimed or verified business', () => {
      expect(buildWhyPairleyBullets(BusinessStatus.CLAIMED, false)).toContain(
        'Verified Local Partner',
      );
      expect(buildWhyPairleyBullets(BusinessStatus.UNCLAIMED, true)).toContain(
        'Verified Local Partner',
      );
    });

    it('handles missing status gracefully', () => {
      expect(() => buildWhyPairleyBullets(null, undefined)).not.toThrow();
      expect(buildWhyPairleyBullets(null, undefined)).not.toContain(
        'Verified Local Partner',
      );
    });
  });

  describe('buildDealUrl', () => {
    const originalEnv = process.env.PAIRLEY_WEB_URL;
    afterEach(() => {
      process.env.PAIRLEY_WEB_URL = originalEnv;
    });

    it('builds the deal URL under the default production domain', () => {
      delete process.env.PAIRLEY_WEB_URL;
      expect(buildDealUrl('offer-123')).toBe(
        'https://pairley.com/deals/offer-123',
      );
    });

    it('respects an overridden PAIRLEY_WEB_URL, including a trailing slash', () => {
      process.env.PAIRLEY_WEB_URL = 'https://staging.pairley.com/';
      expect(buildDealUrl('offer-123')).toBe(
        'https://staging.pairley.com/deals/offer-123',
      );
    });

    it('returns null without an offer id, rather than a broken link', () => {
      expect(buildDealUrl(null)).toBeNull();
      expect(buildDealUrl(undefined)).toBeNull();
      expect(buildDealUrl('')).toBeNull();
    });
  });
});
