import { OfferType } from '@prisma/client';
import {
  renderPairleyCopy,
  getCopyCatalog,
  getSupportedLocales,
  DEFAULT_LOCALE,
} from './pairleyCopyTemplates';

describe('pairleyCopyTemplates (Module 14 Phase 3B)', () => {
  describe('catalog completeness', () => {
    it('has copy for every OfferType the schema defines', () => {
      const covered = getCopyCatalog().map((e) => e.offerType).sort();
      expect(covered).toEqual(Object.values(OfferType).sort());
    });

    it('gives every entry a non-empty headline and body', () => {
      getCopyCatalog().forEach((entry) => {
        expect(entry.headline.trim().length).toBeGreaterThan(0);
        expect(entry.body.trim().length).toBeGreaterThan(0);
      });
    });

    it('reports its supported locales', () => {
      expect(getSupportedLocales()).toContain(DEFAULT_LOCALE);
    });
  });

  // The load-bearing rule: Pairley must never state that a group *will*
  // form, only that the offer unlocks when the required participation is
  // reached. This is enforced structurally across the whole catalog rather
  // than trusted per-entry, so a future addition can't quietly break it.
  describe('never promises a group will form', () => {
    const FORBIDDEN = [
      /\bwe(?:'| w)ill find\b/i,
      /\bwe(?:'| w)ill match\b/i,
      /\bwill be matched\b/i,
      /\byour group will\b/i,
      /\bgroup will form\b/i,
      /\bwe(?:'| w)ill pair\b/i,
      /\bguarantee/i,
      /\bassured\b/i,
      /\bdefinitely\b/i,
      /\bwe find you\b/i,
    ];

    it('contains no promise language in any catalog string', () => {
      getCopyCatalog().forEach((entry) => {
        const text = `${entry.headline} ${entry.body} ${entry.soloHeadline ?? ''} ${entry.soloBody ?? ''}`;
        FORBIDDEN.forEach((pattern) => {
          expect(text).not.toMatch(pattern);
        });
      });
    });

    it('contains no promise language in any rendered output', () => {
      Object.values(OfferType).forEach((offerType) => {
        [1, 2, 5, 10].forEach((requiredPeople) => {
          const { headline, body } = renderPairleyCopy(offerType, { requiredPeople });
          FORBIDDEN.forEach((pattern) => {
            expect(`${headline} ${body}`).not.toMatch(pattern);
          });
        });
      });
    });

    // Positive counterpart: group copy should state the condition.
    it('states the condition for every group offer', () => {
      Object.values(OfferType).forEach((offerType) => {
        const { body, groupRequired } = renderPairleyCopy(offerType, {
          requiredPeople: 4,
        });
        expect(groupRequired).toBe(true);
        expect(body).toMatch(/once|when/i);
      });
    });
  });

  describe('rendering', () => {
    it('produces the approved BOGO wording', () => {
      const { headline, body } = renderPairleyCopy(OfferType.BOGO, {
        requiredPeople: 2,
      });
      expect(headline).toMatch(/one seat/i);
      expect(body).toMatch(/another customer also shows interest/i);
      expect(body).toMatch(/per-person cost/i);
    });

    it('interpolates the required group size', () => {
      const { body } = renderPairleyCopy(OfferType.BUY_X_GET_Y, {
        requiredPeople: 10,
      });
      expect(body).toContain('10 people');
      expect(body).not.toContain('{{people}}');
    });

    it('never leaves an uninterpolated placeholder for any type or size', () => {
      Object.values(OfferType).forEach((offerType) => {
        [0, 1, 2, 7].forEach((requiredPeople) => {
          const { body, headline } = renderPairleyCopy(offerType, { requiredPeople });
          expect(`${headline} ${body}`).not.toContain('{{');
        });
      });
    });

    // "1 people" is the kind of detail that makes a marketplace look cheap.
    it('never produces "1 people"', () => {
      Object.values(OfferType).forEach((offerType) => {
        [0, 1].forEach((requiredPeople) => {
          const { body } = renderPairleyCopy(offerType, { requiredPeople });
          expect(body).not.toMatch(/\b1 people\b/);
        });
      });
    });

    // Regression: {{people}} used to expand to "12 people", which produced
    // "once 12 people customers have shown interest" in every template that
    // already supplied its own noun. Caught by rendering a real banner and
    // reading it, not by any assertion that existed at the time.
    it('never doubles the noun after the participant count', () => {
      const DOUBLED = /\d+\s+(people|customers|members)\s+(people|customers|members)\b/i;
      Object.values(OfferType).forEach((offerType) => {
        [2, 5, 12].forEach((requiredPeople) => {
          const { body, headline } = renderPairleyCopy(offerType, { requiredPeople });
          expect(`${headline} ${body}`).not.toMatch(DOUBLED);
        });
      });
    });

    it('always states the count with a noun, never as a bare number', () => {
      Object.values(OfferType).forEach((offerType) => {
        const { body } = renderPairleyCopy(offerType, { requiredPeople: 7 });
        if (body.includes('7')) {
          expect(body).toMatch(/7\s+(people|customers|members)\b/i);
        }
      });
    });
  });

  describe('solo vs group variants', () => {
    it('uses solo wording when no group is required', () => {
      const solo = renderPairleyCopy(OfferType.FLAT_DISCOUNT, { requiredPeople: 1 });
      expect(solo.groupRequired).toBe(false);
      expect(solo.templateKey).toBe('FLAT_DISCOUNT_SOLO');
      expect(solo.body).not.toMatch(/once \d+ customers/i);
    });

    it('uses group wording as soon as more than one participant is needed', () => {
      const group = renderPairleyCopy(OfferType.FLAT_DISCOUNT, { requiredPeople: 3 });
      expect(group.groupRequired).toBe(true);
      expect(group.templateKey).toBe('FLAT_DISCOUNT');
      // The noun belongs to the template, not the placeholder — this one
      // reads "3 customers", not "3 people".
      expect(group.body).toMatch(/\b3 customers\b/);
    });

    // BOGO is inherently a pairing mechanic — it has no solo variant, and
    // must not silently render group copy with a nonsense participant count.
    it('falls back to sensible group wording for a type with no solo variant', () => {
      const { body } = renderPairleyCopy(OfferType.BOGO, { requiredPeople: 1 });
      expect(body).toMatch(/another customer/i);
      expect(body).not.toContain('{{');
    });
  });

  describe('robustness', () => {
    it('falls back to STANDARD for an unknown offer type rather than throwing', () => {
      const result = renderPairleyCopy('NOT_A_REAL_TYPE', { requiredPeople: 3 });
      expect(result.templateKey).toBe(OfferType.STANDARD);
      expect(result.body.length).toBeGreaterThan(0);
    });

    it('handles missing, null and nonsense participant counts', () => {
      [undefined, null, NaN, -5].forEach((requiredPeople) => {
        const result = renderPairleyCopy(OfferType.STANDARD, {
          requiredPeople: requiredPeople as number,
        });
        expect(result.body).not.toContain('{{');
        expect(result.groupRequired).toBe(false);
      });
    });

    it('falls back to the default locale for an unsupported one', () => {
      const result = renderPairleyCopy(OfferType.BOGO, {
        requiredPeople: 2,
        locale: 'fr' as never,
      });
      expect(result.body).toMatch(/another customer/i);
    });
  });
});
