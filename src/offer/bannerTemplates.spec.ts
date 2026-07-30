import { OfferType } from '@prisma/client';
import {
  recommendTemplate,
  orientationOf,
  resolveTemplate,
  isTemplateId,
  BANNER_TEMPLATES,
  TEMPLATE_IDS,
  DEFAULT_TEMPLATE,
} from './bannerTemplates';

describe('bannerTemplates (Module 14 Phase 3C)', () => {
  describe('library', () => {
    it('defines all six templates', () => {
      expect(TEMPLATE_IDS).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
      TEMPLATE_IDS.forEach((id) => {
        const t = BANNER_TEMPLATES[id];
        expect(t.name).toBeTruthy();
        expect(t.description).toBeTruthy();
        expect(t.titleBudget).toBeGreaterThan(0);
        expect(t.suitsOrientation.length).toBeGreaterThan(0);
      });
    });

    it('gives the split layout the largest title budget, since text is its point', () => {
      const budgets = TEMPLATE_IDS.map(
        (id) => BANNER_TEMPLATES[id].titleBudget,
      );
      expect(BANNER_TEMPLATES.B.titleBudget).toBe(Math.max(...budgets));
    });
  });

  describe('orientationOf', () => {
    it('classifies the three orientations', () => {
      expect(orientationOf(1600, 900)).toBe('landscape');
      expect(orientationOf(900, 1600)).toBe('portrait');
      expect(orientationOf(1000, 1000)).toBe('square');
      expect(orientationOf(1050, 1000)).toBe('square');
    });

    it('returns null for unusable dimensions', () => {
      expect(orientationOf(null, null)).toBeNull();
      expect(orientationOf(0, 100)).toBeNull();
      expect(orientationOf(100, -5)).toBeNull();
    });
  });

  describe('category steering', () => {
    it.each([
      ['dining', 'C'],
      ['travel', 'C'],
      ['fitness', 'D'],
      ['health', 'D'],
      ['electronics', 'E'],
      ['shopping', 'E'],
      ['beauty', 'B'],
    ])(
      'recommends %s -> Template %s on an otherwise neutral offer',
      (category, expected) => {
        const result = recommendTemplate({
          category,
          offerType: OfferType.STANDARD,
          heroOrientation: 'square',
          hasHeroImage: true,
          titleLength: 24,
          badgeCount: 2,
        });
        expect(result.templateId).toBe(expected);
      },
    );

    it('is case-insensitive about category', () => {
      expect(
        recommendTemplate({
          category: 'DINING',
          heroOrientation: 'landscape',
          hasHeroImage: true,
          titleLength: 20,
        }).templateId,
      ).toBe('C');
    });
  });

  describe('fit beats taste', () => {
    // The point of considering more than category: a layout that truncates
    // the title is worse than one that merely suits the trade less well.
    it('abandons the category pick when the title would be truncated', () => {
      const short = recommendTemplate({
        category: 'fitness',
        heroOrientation: 'square',
        hasHeroImage: true,
        titleLength: 20,
      });
      const long = recommendTemplate({
        category: 'fitness',
        heroOrientation: 'square',
        hasHeroImage: true,
        titleLength: 70,
      });
      expect(short.templateId).toBe('D');
      expect(long.templateId).toBe('B');
      expect(long.reasons.join(' ')).not.toMatch(/truncated/i);
    });

    it('never recommends a hero-requiring layout when there is no image', () => {
      const result = recommendTemplate({
        category: 'beauty', // would otherwise steer to B, which needs a hero
        hasHeroImage: false,
        heroOrientation: null,
        titleLength: 25,
      });
      expect(BANNER_TEMPLATES[result.templateId].worksWithoutHero).toBe(true);
      expect(result.templateId).not.toBe('B');
    });

    it('avoids a layout that suits the image orientation poorly', () => {
      const result = recommendTemplate({
        category: 'shopping',
        heroOrientation: 'portrait',
        hasHeroImage: true,
        titleLength: 25,
      });
      expect(BANNER_TEMPLATES[result.templateId].suitsOrientation).toContain(
        'portrait',
      );
    });

    it('penalises a layout carrying more badges than it shows cleanly', () => {
      const many = recommendTemplate({
        category: 'dining',
        heroOrientation: 'landscape',
        hasHeroImage: true,
        titleLength: 25,
        badgeCount: 6,
      });
      expect(many.scores.find((s) => s.templateId === 'C')!.score).toBeLessThan(
        recommendTemplate({
          category: 'dining',
          heroOrientation: 'landscape',
          hasHeroImage: true,
          titleLength: 25,
          badgeCount: 1,
        }).scores.find((s) => s.templateId === 'C')!.score,
      );
    });
  });

  describe('offer type', () => {
    it('prefers the split layout for a multi-step offer mechanic', () => {
      const result = recommendTemplate({
        category: 'services',
        offerType: OfferType.BUY_X_GET_Y,
        heroOrientation: 'portrait',
        hasHeroImage: true,
        titleLength: 30,
      });
      expect(result.templateId).toBe('B');
      expect(result.reasons.join(' ')).toMatch(/multi-step|split/i);
    });

    it('does not force the split layout for a simple discount', () => {
      const result = recommendTemplate({
        category: 'dining',
        offerType: OfferType.PERCENTAGE_DISCOUNT,
        heroOrientation: 'landscape',
        hasHeroImage: true,
        titleLength: 25,
      });
      expect(result.templateId).toBe('C');
    });
  });

  describe('output shape', () => {
    it('explains itself and scores every template', () => {
      const result = recommendTemplate({
        category: 'dining',
        heroOrientation: 'landscape',
        hasHeroImage: true,
        titleLength: 25,
      });
      expect(result.scores).toHaveLength(6);
      expect(result.scores[0].templateId).toBe(result.templateId);
      expect(result.template.id).toBe(result.templateId);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(0.95);
    });

    it('returns lower confidence when two templates are close', () => {
      const clear = recommendTemplate({
        category: 'fitness',
        heroOrientation: 'square',
        hasHeroImage: true,
        titleLength: 20,
      });
      const murky = recommendTemplate({
        category: 'unknown-category',
        heroOrientation: 'square',
        hasHeroImage: true,
        titleLength: 20,
      });
      expect(murky.confidence).toBeLessThan(clear.confidence);
    });

    // The same offer must always get the same recommendation.
    it('is deterministic', () => {
      const input = {
        category: 'shopping',
        heroOrientation: 'square' as const,
        hasHeroImage: true,
        titleLength: 30,
      };
      expect(recommendTemplate(input).templateId).toBe(
        recommendTemplate(input).templateId,
      );
    });

    it('always returns a valid template for empty input', () => {
      const result = recommendTemplate({});
      expect(TEMPLATE_IDS).toContain(result.templateId);
    });

    it('handles junk input without throwing', () => {
      expect(() =>
        recommendTemplate({
          category: null,
          offerType: 'NOT_A_TYPE',
          titleLength: NaN,
          badgeCount: -3,
        }),
      ).not.toThrow();
    });
  });

  describe('Template F (Cost-Split) recommendation', () => {
    const compellingF = {
      category: 'dining',
      offerType: OfferType.BOGO,
      heroOrientation: 'square' as const,
      hasHeroImage: true,
      titleLength: 20,
      costSplitEligible: true,
      requiredPeople: 2,
      discountPercent: 50,
    };

    // The headline requirement: a group offer with a genuine split and a
    // saving worth leading with should pick F *over* the category default,
    // because the group-buying story is what differentiates Pairley.
    it('prefers F over the category default when all three conditions hold', () => {
      const result = recommendTemplate(compellingF);
      expect(result.templateId).toBe('F');
      expect(result.reasons.join(' ')).toMatch(/savings story leads/i);
    });

    it('prefers F over the category default across categories, not just dining', () => {
      ['fitness', 'electronics', 'beauty', 'travel', 'shopping'].forEach(
        (category) => {
          expect(
            recommendTemplate({ ...compellingF, category }).templateId,
          ).toBe('F');
        },
      );
    });

    it('still offers F as a contender for a modest saving, without leading with it', () => {
      const result = recommendTemplate({
        ...compellingF,
        discountPercent: 10,
      });
      const fScore = result.scores.find((s) => s.templateId === 'F')!.score;
      const compellingScore = recommendTemplate(compellingF).scores.find(
        (s) => s.templateId === 'F',
      )!.score;
      expect(fScore).toBeLessThan(compellingScore);
      expect(result.reasons.join(' ')).not.toMatch(/savings story leads/i);
    });

    // A "split" needs two sides — a single-participant offer has none, no
    // matter how large the discount.
    it('never recommends F for a single-participant offer', () => {
      const result = recommendTemplate({
        ...compellingF,
        requiredPeople: 1,
        costSplitEligible: false,
      });
      expect(result.templateId).not.toBe('F');
      // The penalty applies on top of the ordinary fit score, so F's total
      // can stay positive — what matters is that it lands well behind the
      // winner rather than that it goes negative.
      const fScore = result.scores.find((s) => s.templateId === 'F')!.score;
      expect(fScore).toBeLessThan(result.scores[0].score - 30);
      expect(result.reasons.join(' ')).not.toMatch(/split/i);
    });

    it('never recommends F without a genuine split, even for a BOGO offer', () => {
      const result = recommendTemplate({
        category: 'dining',
        offerType: OfferType.BOGO,
        heroOrientation: 'landscape',
        hasHeroImage: true,
        titleLength: 20,
        costSplitEligible: false,
      });
      expect(result.templateId).not.toBe('F');
    });

    it('defaults to costSplitEligible: false when omitted, never assuming eligibility', () => {
      const result = recommendTemplate({
        category: 'dining',
        heroOrientation: 'landscape',
        hasHeroImage: true,
        titleLength: 20,
      });
      expect(result.templateId).not.toBe('F');
    });
  });

  describe('resolveTemplate / isTemplateId', () => {
    it('accepts valid ids', () => {
      expect(isTemplateId('C')).toBe(true);
      expect(resolveTemplate('C').id).toBe('C');
    });

    // An admin override arrives as untrusted input from an API body.
    it('falls back to the default for anything invalid', () => {
      ['Z', '', null, undefined, 42, {}].forEach((value) => {
        expect(isTemplateId(value)).toBe(false);
        expect(resolveTemplate(value).id).toBe(DEFAULT_TEMPLATE);
      });
    });
  });
});
