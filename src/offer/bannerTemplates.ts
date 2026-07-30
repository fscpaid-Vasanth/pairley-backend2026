import { OfferType } from '@prisma/client';

/**
 * Module 14 Phase 3C — the banner template library and the engine that
 * recommends one.
 *
 * The admin can always override the recommendation; the point of this file is
 * that they shouldn't *have* to, on the common path. The recommendation is
 * deterministic and explainable — a reason string comes back with every
 * choice — so a surprising pick can be understood rather than argued with.
 *
 * Selection deliberately considers more than category, because the thing that
 * actually ruins a banner is a layout that can't hold its content: a
 * landscape photo in a portrait frame, or 90 characters of title in a
 * template that budgets 40. Those are the inputs weighted most heavily.
 */

export type TemplateId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface BannerTemplate {
  id: TemplateId;
  name: string;
  description: string;
  /** width / height the hero region wants. */
  heroAspect: number;
  /** Roughly how many title characters the layout holds comfortably. */
  titleBudget: number;
  /** How many badges/chips it can show before it looks crowded. */
  badgeBudget: number;
  /** Image orientations this layout flatters. */
  suitsOrientation: Orientation[];
  /** True when the layout works with no hero image at all. */
  worksWithoutHero: boolean;
}

export type Orientation = 'landscape' | 'portrait' | 'square';

export const BANNER_TEMPLATES: Record<TemplateId, BannerTemplate> = {
  A: {
    id: 'A',
    name: 'Hero Spotlight',
    description:
      'Large hero image, prominent discount badge, CTA at the bottom.',
    heroAspect: 1,
    titleBudget: 44,
    badgeBudget: 3,
    suitsOrientation: ['square', 'landscape'],
    worksWithoutHero: true,
  },
  B: {
    id: 'B',
    name: 'Split Detail',
    description:
      'Split layout — image on the left, offer details on the right.',
    heroAspect: 0.75,
    // The text column is the point of this layout, so it holds the most.
    titleBudget: 72,
    badgeBudget: 4,
    suitsOrientation: ['portrait', 'square'],
    worksWithoutHero: false,
  },
  C: {
    id: 'C',
    name: 'Premium Card',
    description: 'Editorial card styling for restaurants, hotels and travel.',
    heroAspect: 1.4,
    titleBudget: 52,
    badgeBudget: 2,
    suitsOrientation: ['landscape', 'square'],
    worksWithoutHero: true,
  },
  D: {
    id: 'D',
    name: 'Active',
    description: 'High-energy treatment for gyms, fitness and sports.',
    heroAspect: 1,
    titleBudget: 40,
    badgeBudget: 3,
    suitsOrientation: ['square', 'portrait'],
    worksWithoutHero: true,
  },
  E: {
    id: 'E',
    name: 'Product Grid',
    description: 'Clean product-forward styling for retail and electronics.',
    heroAspect: 1,
    titleBudget: 48,
    badgeBudget: 4,
    suitsOrientation: ['square', 'landscape'],
    worksWithoutHero: true,
  },
  // Module 14 Phase 3C follow-up — the "cost-split" design: a numeric
  // Actual Price / You Pay / You Save breakdown closing on the group's
  // combined saving, a 3-step unlock diagram, an Offer Partner card, a Why
  // Pairley panel, and a QR code linking to the real deal page. Deliberately
  // its own template rather than a reshape of B: the math box only says
  // anything worth saying when a group genuinely lowers the price (see
  // costSplitBanner.ts's computeCostSplit), so this layout should be picked
  // for that specific mechanic, not for every "detail heavy" offer B
  // already covers.
  F: {
    id: 'F',
    name: 'Cost-Split',
    description:
      'Breaks down what you pay, what you save, and what the group saves together, with the 3-step unlock process and a scannable link to the deal.',
    heroAspect: 1.2,
    titleBudget: 40,
    badgeBudget: 2,
    suitsOrientation: ['square', 'landscape'],
    worksWithoutHero: true,
  },
};

export const TEMPLATE_IDS: TemplateId[] = ['A', 'B', 'C', 'D', 'E', 'F'];

export const DEFAULT_TEMPLATE: TemplateId = 'A';

/** Category → the template that suits that trade's imagery. */
const CATEGORY_TEMPLATE: Record<string, TemplateId> = {
  dining: 'C',
  travel: 'C',
  entertainment: 'C',
  fitness: 'D',
  health: 'D',
  beauty: 'B',
  services: 'B',
  education: 'B',
  electronics: 'E',
  shopping: 'E',
  groceries: 'E',
  automotive: 'E',
};

/** Offer types whose mechanic is easier to read in the split layout. */
const DETAIL_HEAVY_OFFER_TYPES = new Set<string>([
  OfferType.BOGT,
  OfferType.BUY_X_GET_Y,
  OfferType.BULK_PURCHASE,
  OfferType.PACKAGE_DEAL,
  OfferType.MEMBERSHIP_CAMPAIGN,
]);

export interface RecommendationInput {
  category?: string | null;
  offerType?: string | null;
  /** Orientation of the chosen hero image, if there is one. */
  heroOrientation?: Orientation | null;
  hasHeroImage?: boolean;
  /** Length of the offer title, in characters. */
  titleLength?: number | null;
  /** How many badges/chips the banner will carry. */
  badgeCount?: number | null;
  /**
   * True only when the offer has a real group price worth breaking down —
   * two or more participants, a genuinely lower offer price, and a saving
   * that is neither a rounding sliver nor implausibly large (see
   * `costSplitBanner.ts`'s `computeCostSplit`). This is what makes Template
   * F's math box quote real figures rather than invented ones. The caller
   * computes it once, from the same function the renderer itself uses,
   * rather than this file re-deriving price logic it has no other reason to
   * know about.
   */
  costSplitEligible?: boolean;
  /** How many participants the offer needs. Template F's whole premise. */
  requiredPeople?: number | null;
  /** Percentage off, when there is a genuine one. Drives "is this saving
   *  worth building the layout around". */
  discountPercent?: number | null;
}

/**
 * The saving at which the cost-split layout is worth leading with. Below
 * this a discount is real but not the story — the offer is better served
 * by a template that leads with the product or the venue, and the ordinary
 * discount chip carries the number perfectly well.
 */
export const COMPELLING_DISCOUNT_PERCENT = 25;

export interface TemplateRecommendation {
  templateId: TemplateId;
  template: BannerTemplate;
  confidence: number;
  reasons: string[];
  /** Every template, scored — so the admin UI can show why. */
  scores: { templateId: TemplateId; score: number }[];
}

/**
 * The single place the landscape/portrait/square thresholds live. Exported
 * so heroImageRanking's suitability score can classify a template's
 * *target* aspect the same way orientationOf classifies an *image's*
 * aspect — one definition of "what counts as landscape", not two that could
 * silently drift apart.
 */
export function classifyAspect(aspect: number): Orientation {
  if (aspect >= 1.2) return 'landscape';
  if (aspect <= 0.83) return 'portrait';
  return 'square';
}

export function orientationOf(
  width?: number | null,
  height?: number | null,
): Orientation | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  return classifyAspect(width / height);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Scores every template and returns the best.
 *
 * Weighting reflects what actually goes wrong: content that doesn't fit is
 * penalised hardest (truncation is visible and looks broken), orientation
 * mismatch next (forces an ugly crop), then category and offer-type fit,
 * which are taste rather than correctness.
 */
export function recommendTemplate(
  input: RecommendationInput,
): TemplateRecommendation {
  const category = String(input.category ?? '').toLowerCase();
  const offerType = String(input.offerType ?? '');
  const titleLength = Number(input.titleLength ?? 0);
  const badgeCount = Number(input.badgeCount ?? 0);
  const hasHero =
    input.hasHeroImage !== false &&
    Boolean(input.heroOrientation ?? input.hasHeroImage);

  const categoryPick = CATEGORY_TEMPLATE[category];
  const reasonsById = new Map<TemplateId, string[]>();

  const scores = TEMPLATE_IDS.map((templateId) => {
    const template = BANNER_TEMPLATES[templateId];
    const reasons: string[] = [];
    let score = 0;

    // --- Fit: the dominant signal ------------------------------------
    if (titleLength > 0) {
      if (titleLength <= template.titleBudget) {
        score += 30;
      } else {
        const overflow = titleLength - template.titleBudget;
        // Past ~20 characters over budget the title is unavoidably cut.
        score -= clamp((overflow / 20) * 40, 0, 45);
        reasons.push('Title may be truncated');
      }
    }

    if (badgeCount > template.badgeBudget) {
      score -= 12;
      reasons.push('More badges than this layout shows cleanly');
    }

    // --- Imagery ------------------------------------------------------
    if (!hasHero) {
      if (template.worksWithoutHero) {
        score += 12;
      } else {
        score -= 40;
        reasons.push('Needs a hero image');
      }
    } else if (input.heroOrientation) {
      if (template.suitsOrientation.includes(input.heroOrientation)) {
        score += 20;
      } else {
        score -= 15;
        reasons.push(`${input.heroOrientation} image suits this layout poorly`);
      }
    }

    // --- Taste --------------------------------------------------------
    if (categoryPick === templateId) {
      score += 18;
      reasons.push(`Suits ${category}`);
    }

    if (DETAIL_HEAVY_OFFER_TYPES.has(offerType) && templateId === 'B') {
      score += 14;
      reasons.push('Split layout explains a multi-step offer more clearly');
    }

    // Template F earns its place only when there's real cost-split content
    // to show — otherwise its distinctive math box would be empty, and a
    // generic template serves the offer better.
    //
    // When all three conditions hold (a group offer, a genuine split, and a
    // saving big enough to be worth leading with) the group-buying story
    // *is* the offer, so F is scored to win outright rather than merely
    // compete with the category preference — the whole point of the layout
    // is that this mechanic is what differentiates Pairley.
    if (templateId === 'F') {
      const requiredPeople = Number(input.requiredPeople ?? 0);
      const discountPercent = Number(input.discountPercent ?? 0);
      const isGroupOffer =
        Number.isFinite(requiredPeople) && requiredPeople >= 2;
      const isCompellingSaving =
        Number.isFinite(discountPercent) &&
        discountPercent >= COMPELLING_DISCOUNT_PERCENT;

      if (input.costSplitEligible && isGroupOffer && isCompellingSaving) {
        score += 42;
        reasons.push(
          `${Math.round(discountPercent)}% off split across ${Math.round(requiredPeople)} people — the savings story leads`,
        );
      } else if (input.costSplitEligible && isGroupOffer) {
        score += 20;
        reasons.push('Price splits cleanly between participants');
      } else {
        score -= 35;
        reasons.push(
          isGroupOffer
            ? 'No clean price split to show'
            : 'Not a group offer — nothing to split',
        );
      }
    }

    reasonsById.set(templateId, reasons);
    return { templateId, score: Math.round(score * 100) / 100 };
  });

  const sorted = [...scores].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tiebreak, so the same offer always gets the same
    // recommendation rather than depending on object ordering.
    return (
      TEMPLATE_IDS.indexOf(a.templateId) - TEMPLATE_IDS.indexOf(b.templateId)
    );
  });

  const winner = sorted[0];
  const runnerUp = sorted[1];
  const margin = runnerUp ? winner.score - runnerUp.score : 40;
  const confidence = clamp(0.35 + (margin / 40) * 0.6, 0.35, 0.95);

  return {
    templateId: winner.templateId,
    template: BANNER_TEMPLATES[winner.templateId],
    confidence: Math.round(confidence * 100) / 100,
    reasons: reasonsById.get(winner.templateId) ?? [],
    scores: sorted,
  };
}

export function isTemplateId(value: unknown): value is TemplateId {
  return (
    typeof value === 'string' && TEMPLATE_IDS.includes(value as TemplateId)
  );
}

export function resolveTemplate(value: unknown): BannerTemplate {
  return isTemplateId(value)
    ? BANNER_TEMPLATES[value]
    : BANNER_TEMPLATES[DEFAULT_TEMPLATE];
}
