import { OfferType } from '@prisma/client';
import { RuleBasedEnrichmentProvider } from './rule-based-enrichment.provider';
import { EnrichmentInput } from './enrichment-provider';

function input(overrides: Partial<EnrichmentInput> = {}): EnrichmentInput {
  return {
    title: 'Diwali Mega Sale',
    description: 'Flat 40% off storewide',
    currentCategory: 'shopping',
    currentOfferType: OfferType.PERCENTAGE_DISCOUNT,
    ...overrides,
  };
}

describe('RuleBasedEnrichmentProvider', () => {
  let provider: RuleBasedEnrichmentProvider;

  beforeEach(() => {
    provider = new RuleBasedEnrichmentProvider();
  });

  describe('category suggestions', () => {
    const cases: Array<[string, string]> = [
      ['Best pizza and burger restaurant in town', 'dining'],
      ['Annual gym membership with free yoga classes', 'fitness'],
      ['Bridal makeup and hair salon package', 'beauty'],
      ['Dental clinic full checkup offer', 'healthcare'],
      ['Spoken English coaching classes', 'education'],
      ['Goa holiday package with sightseeing', 'tours'],
      ['Weekend river rafting adventure trip', 'adventure'],
      ['Multiplex cinema movie ticket combo', 'entertainment'],
      ['Annual plan subscription for streaming', 'subscriptions'],
      ['Emergency plumber and electrician home repair', 'home-services'],
      ['Coworking hot desk monthly pass', 'coworking'],
    ];

    it.each(cases)('suggests "%s" -> %s', async (text, expectedCategory) => {
      const result = await provider.enrich(
        input({ title: text, description: '' }),
      );
      expect(result.category.suggested).toBe(expectedCategory);
      expect(result.category.confidence).toBeGreaterThan(0.5);
      expect(result.category.original).toBe('shopping');
    });

    it('falls back to the current/default category with low confidence when nothing matches', async () => {
      const result = await provider.enrich(
        input({
          title: 'Grand Opening Special',
          description: 'Everything must go',
        }),
      );
      expect(result.category.suggested).toBe('shopping');
      expect(result.category.confidence).toBeLessThan(0.5);
      expect(result.category.rationale).toContain(
        'No confident category keywords',
      );
    });
  });

  describe('offer type consistency', () => {
    it('echoes the already-classified offer_type with high confidence, not STANDARD', async () => {
      const result = await provider.enrich(
        input({ currentOfferType: OfferType.BOGO }),
      );
      expect(result.offerType.suggested).toBe(OfferType.BOGO);
      expect(result.offerType.original).toBe(OfferType.BOGO);
      expect(result.offerType.confidence).toBeGreaterThan(0.5);
    });

    it('reports low confidence when the offer never got past the STANDARD fallback', async () => {
      const result = await provider.enrich(
        input({ currentOfferType: OfferType.STANDARD }),
      );
      expect(result.offerType.suggested).toBe(OfferType.STANDARD);
      expect(result.offerType.confidence).toBeLessThan(0.5);
      expect(result.offerType.rationale).toContain(
        'No offer-type keywords matched',
      );
    });

    it('never suggests a different offer_type than what is already stored — Phase 3 does not re-classify', async () => {
      const result = await provider.enrich(
        input({ currentOfferType: OfferType.FESTIVAL }),
      );
      expect(result.offerType.suggested).toBe(result.offerType.original);
    });
  });

  describe('merchant type suggestions', () => {
    it('derives a merchant type label from the same category match', async () => {
      const result = await provider.enrich(
        input({ title: 'Family restaurant dining offer', description: '' }),
      );
      expect(result.merchantType.suggested).toBe('Restaurant / Food Service');
    });

    it('falls back to a generic retail label when nothing matches', async () => {
      const result = await provider.enrich(
        input({
          title: 'Grand Opening Special',
          description: 'Everything must go',
        }),
      );
      expect(result.merchantType.suggested).toBe('Retail Store');
    });
  });

  describe('tag generation', () => {
    it('generates non-empty tags from a real title', async () => {
      const result = await provider.enrich(input());
      expect(result.tags.suggested.length).toBeGreaterThan(0);
      expect(result.tags.confidence).toBe(1);
    });

    it('includes the matched category and offer-type as tags', async () => {
      const result = await provider.enrich(
        input({
          title: 'Family restaurant dining offer',
          currentOfferType: OfferType.BOGO,
        }),
      );
      expect(result.tags.suggested).toContain('dining');
      expect(result.tags.suggested).toContain('bogo');
    });

    it('caps tags at 6 and never duplicates', async () => {
      const result = await provider.enrich(
        input({
          title:
            'sale sale sale mega mega discount offer bonanza clearance blowout extravaganza',
        }),
      );
      expect(result.tags.suggested.length).toBeLessThanOrEqual(6);
      expect(new Set(result.tags.suggested).size).toBe(
        result.tags.suggested.length,
      );
    });

    it('reports zero confidence and an empty array when there is no title, category, or offer-type signal to draw from', async () => {
      const result = await provider.enrich(
        input({
          title: 'a to',
          description: '',
          currentOfferType: OfferType.STANDARD,
        }),
      );
      expect(result.tags.suggested).toEqual([]);
      expect(result.tags.confidence).toBe(0);
    });
  });

  describe('keyword generation', () => {
    it('generates a broader set than tags, including title, description, category, and merchant type', async () => {
      const result = await provider.enrich(
        input({
          title: 'Family restaurant dining offer',
          description: 'Fresh homemade meals every day',
        }),
      );
      expect(result.keywords.suggested.length).toBeGreaterThan(
        result.tags.suggested.length,
      );
      expect(result.keywords.suggested).toContain('dining');
      expect(result.keywords.confidence).toBe(1);
    });

    it('caps keywords at 15', async () => {
      const longText = Array.from({ length: 30 }, (_, i) => `word${i}`).join(
        ' ',
      );
      const result = await provider.enrich(
        input({ title: longText, description: longText }),
      );
      expect(result.keywords.suggested.length).toBeLessThanOrEqual(15);
    });
  });

  describe('explainability metadata shape', () => {
    it('every field carries suggested/original/confidence/rationale', async () => {
      const result = await provider.enrich(input());
      for (const field of [
        'category',
        'offerType',
        'merchantType',
        'tags',
        'keywords',
      ] as const) {
        expect(result[field]).toHaveProperty('suggested');
        expect(result[field]).toHaveProperty('original');
        expect(result[field]).toHaveProperty('confidence');
        expect(result[field]).toHaveProperty('rationale');
        expect(typeof result[field].rationale).toBe('string');
        expect(result[field].rationale.length).toBeGreaterThan(0);
      }
    });
  });
});
