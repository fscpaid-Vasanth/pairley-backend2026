import { Injectable } from '@nestjs/common';
import { OfferType } from '@prisma/client';
import {
  EnrichmentInput,
  EnrichmentProvider,
  EnrichmentResult,
  EnrichmentSuggestion,
} from './enrichment-provider';
import { DEFAULT_CATEGORY } from './candidate-offer.service';

const MATCHED_CONFIDENCE = 0.75;
const UNMATCHED_CONFIDENCE = 0.25;
const DEFAULT_MERCHANT_TYPE = 'Retail Store'; // mirrors auth.service.ts's business_type default ('Retail')

interface CategoryRule {
  pattern: RegExp;
  category: string;
  merchantType: string;
}

// Ordered, first-match-wins — same discipline as NormalizationService's
// offer_type classifier and DuplicateDetectionService's scoring. One rule
// engine drives both category and merchant-type together (rather than two
// independently-maintained keyword dictionaries that could disagree), since
// "what category is this" and "what kind of merchant sells this" are
// answered by the same evidence in practice.
const CATEGORY_RULES: CategoryRule[] = [
  {
    pattern:
      /restaurant|cafe|dining|\bmenu\b|buffet|thali|biryani|\bpizza\b|burger|bakery/i,
    category: 'dining',
    merchantType: 'Restaurant / Food Service',
  },
  {
    pattern: /\bgym\b|fitness|\byoga\b|workout|crossfit|zumba/i,
    category: 'fitness',
    merchantType: 'Fitness Center',
  },
  {
    pattern: /\bsalon\b|\bspa\b|parlour|parlor|facial|makeup|beauty/i,
    category: 'beauty',
    merchantType: 'Salon & Spa',
  },
  {
    pattern:
      /clinic|hospital|\bdoctor\b|dental|dentist|pharmacy|diagnostic|health\s*checkup/i,
    category: 'healthcare',
    merchantType: 'Healthcare Provider',
  },
  {
    pattern:
      /\bcourse\b|coaching|tuition|training|workshop|certification|\bclasses?\b/i,
    category: 'education',
    merchantType: 'Education & Training',
  },
  {
    pattern:
      /\btour\b|travel|vacation|holiday\s*package|sightseeing|itinerary/i,
    category: 'tours',
    merchantType: 'Travel & Tours',
  },
  {
    pattern: /adventure|trekking|rafting|camping|zipline|paragliding|bungee/i,
    category: 'adventure',
    merchantType: 'Adventure & Outdoor',
  },
  {
    pattern:
      /\bmovie\b|cinema|concert|amusement\s*park|gaming\s*zone|event\s*ticket/i,
    category: 'entertainment',
    merchantType: 'Entertainment Venue',
  },
  {
    pattern: /subscription|monthly\s*plan|annual\s*plan/i,
    category: 'subscriptions',
    merchantType: 'Subscription Service',
  },
  {
    pattern:
      /plumb|electrician|pest\s*control|carpenter|home\s*repair|cleaning\s*service|appliance\s*repair/i,
    category: 'home-services',
    merchantType: 'Home Services',
  },
  {
    pattern: /co-?working|workspace|hot\s*desk|office\s*space/i,
    category: 'coworking',
    merchantType: 'Coworking Space',
  },
];

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'of',
  'to',
  'in',
  'on',
  'at',
  'with',
  'only',
  'now',
  'was',
  'this',
  'that',
  'your',
  'our',
  'all',
  'get',
  'you',
  'are',
  'from',
  'per',
  'per person',
  'per',
  'today',
  'here',
]);

function humanize(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

// Deterministic, rule-based only — no LLM/AI inference (Phase 3 scope per
// Decision 1's staged approach). Every suggestion is advisory: nothing here
// writes to Offer.category/offer_type or Business.business_type — only to
// the dedicated enrichment fields (tags/keywords/enrichment_metadata/
// suggested_merchant_type), all of which EnrichmentService persists as
// suggestions the admin explicitly accepts in Phase 4.
@Injectable()
export class RuleBasedEnrichmentProvider extends EnrichmentProvider {
  async enrich(input: EnrichmentInput): Promise<EnrichmentResult> {
    const combinedText = `${input.title} ${input.description}`;
    const matchedRule = CATEGORY_RULES.find((rule) =>
      rule.pattern.test(combinedText),
    );

    const category = this.suggestCategory(input, matchedRule);
    const offerType = this.echoOfferType(input);
    const merchantType = this.suggestMerchantType(matchedRule);
    const tags = this.suggestTags(input, matchedRule, offerType.suggested);
    const keywords = this.suggestKeywords(
      input,
      matchedRule,
      offerType.suggested,
      merchantType.suggested,
    );

    return Promise.resolve({
      category,
      offerType,
      merchantType,
      tags,
      keywords,
    });
  }

  private suggestCategory(
    input: EnrichmentInput,
    matchedRule: CategoryRule | undefined,
  ): EnrichmentSuggestion<string> {
    if (matchedRule) {
      return {
        suggested: matchedRule.category,
        original: input.currentCategory,
        confidence: MATCHED_CONFIDENCE,
        rationale: `Title/description matched keywords associated with "${matchedRule.category}"`,
      };
    }
    return {
      suggested: DEFAULT_CATEGORY,
      original: input.currentCategory,
      confidence: UNMATCHED_CONFIDENCE,
      rationale:
        'No confident category keywords found — no change suggested from the default',
    };
  }

  // Doesn't re-classify — offer_type was already determined deterministically
  // during Phase 1's normalization step (NormalizationService), before this
  // offer ever reached enrichment. This restates that decision inside the
  // same unified EnrichmentResult contract for a complete, one-place audit
  // trail, and reports low confidence when normalization itself couldn't
  // find a signal and fell back to STANDARD.
  private echoOfferType(
    input: EnrichmentInput,
  ): EnrichmentSuggestion<OfferType> {
    const wasClassified = input.currentOfferType !== OfferType.STANDARD;
    return {
      suggested: input.currentOfferType,
      original: input.currentOfferType,
      confidence: wasClassified ? MATCHED_CONFIDENCE : UNMATCHED_CONFIDENCE,
      rationale: wasClassified
        ? `Classified during import normalization based on keyword match (${humanize(input.currentOfferType)})`
        : 'No offer-type keywords matched during import normalization — defaulted to standard',
    };
  }

  private suggestMerchantType(
    matchedRule: CategoryRule | undefined,
  ): EnrichmentSuggestion<string> {
    if (matchedRule) {
      return {
        suggested: matchedRule.merchantType,
        original: null,
        confidence: MATCHED_CONFIDENCE,
        rationale: `Inferred from the same category-matching keywords ("${matchedRule.category}")`,
      };
    }
    return {
      suggested: DEFAULT_MERCHANT_TYPE,
      original: null,
      confidence: UNMATCHED_CONFIDENCE,
      rationale: 'No confident category match — kept as a generic retail label',
    };
  }

  private suggestTags(
    input: EnrichmentInput,
    matchedRule: CategoryRule | undefined,
    offerType: OfferType,
  ): EnrichmentSuggestion<string[]> {
    const words = this.significantWords(input.title, 4);
    const tags = this.dedupe([
      ...words,
      matchedRule?.category ?? null,
      offerType !== OfferType.STANDARD ? humanize(offerType) : null,
    ]).slice(0, 6);

    return {
      suggested: tags,
      original: [],
      confidence: tags.length > 0 ? 1 : 0,
      rationale:
        tags.length > 0
          ? 'Significant words from the title, plus the matched category/offer-type'
          : 'Title had no significant words to extract tags from',
    };
  }

  private suggestKeywords(
    input: EnrichmentInput,
    matchedRule: CategoryRule | undefined,
    offerType: OfferType,
    merchantType: string,
  ): EnrichmentSuggestion<string[]> {
    const words = this.significantWords(
      `${input.title} ${input.description}`,
      12,
    );
    const keywords = this.dedupe([
      ...words,
      matchedRule?.category ?? null,
      offerType !== OfferType.STANDARD ? humanize(offerType) : null,
      merchantType.toLowerCase(),
    ]).slice(0, 15);

    return {
      suggested: keywords,
      original: [],
      confidence: keywords.length > 0 ? 1 : 0,
      rationale:
        keywords.length > 0
          ? 'Broader search terms from the title and description, for discovery/ranking'
          : 'Title/description had no significant words to extract keywords from',
    };
  }

  private significantWords(text: string, max: number): string[] {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    return this.dedupe(words).slice(0, max);
  }

  private dedupe(values: (string | null)[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const v of values) {
      if (v && !seen.has(v)) {
        seen.add(v);
        result.push(v);
      }
    }
    return result;
  }
}
