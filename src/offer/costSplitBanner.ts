import { BusinessStatus } from '@prisma/client';

/**
 * Module 14 Phase 3C follow-up — content for the "Cost-Split" banner
 * (Template F): the numeric Actual-Price/You-Pay/You-Save box and its
 * group-saving summary, the hero discount badge, the 3-step unlock diagram,
 * and the Why-Pairley panel.
 *
 * Pure and side-effect free, same discipline as pairleyCopyTemplates.ts and
 * bannerLayout.ts: every string here is a deterministic function of
 * structured offer/business fields, never a model call, so it can be
 * reviewed once and trusted on every offer thereafter.
 */

export interface CostSplit {
  /** e.g. "₹10,000" — the per-person price without the group, struck through. */
  actualPriceLabel: string;
  /** e.g. "₹5,000" — the per-person price once the group unlocks. */
  yourShareLabel: string;
  /** e.g. "₹5,000" — actual price minus offer price, per person. */
  yourSavingLabel: string;
  /** e.g. "₹2,50,000" — the whole group's saving, group size × per-person saving. */
  groupSavingLabel: string;
  /** "You Both Save" for exactly 2 people, "You All Save" for more —
   *  "Both" is only grammatically correct for a 2-person group. */
  groupSavingLead: string;
  /** e.g. "50 × ₹5,000" — shows the group total's arithmetic on the banner
   *  itself, so a reader can check the headline figure rather than trust it. */
  groupSavingWorking: string;
}

const MIN_SAVING_FRACTION = 0.05; // below this it is a discount chip, not a story
const MIN_PAID_FRACTION = 0.05; // a >95% "discount" is bad data, not an offer

/**
 * Returns the group-savings box content, or `null` when there is nothing
 * honest to show.
 *
 * PRICE SEMANTICS — the thing to get right here. Across this platform
 * `original_price` and `offer_price` are both PER PERSON: the customer-facing
 * DealCard renders `offer_price` as the price, `original_price` struck
 * through, and `original_price - offer_price` as "Save ₹X". This box states
 * the same three quantities, so a customer who compares the banner against
 * the deal page sees matching numbers.
 *
 * It deliberately does NOT present a "you pay half, your partner pays the
 * other half" split. That framing reads correctly only when the discount is
 * exactly 50% and the group is exactly 2 — true of every BOGO, which is why
 * it survives casual review — and is badly wrong everywhere else. On a real
 * GROUP_DISCOUNT of ₹10,000 → ₹5,000 for 50 people it would claim the other
 * 49 people pay ₹5,000 between them, when they pay ₹245,000; and it would
 * strike through ₹10,000 only to celebrate the identical ₹10,000 as the
 * group total, arguing the deal saves nothing.
 *
 * Every figure below is therefore either quoted straight from the offer or
 * is one multiplication away from it, and `groupSavingWorking` prints that
 * multiplication on the banner so the headline stays checkable.
 *
 * Withheld entirely when the claim wouldn't hold up:
 *  - no genuine original/offer price pair,
 *  - the offer price isn't actually lower than the original,
 *  - fewer than 2 participants (no group, so no group saving),
 *  - the saving is a rounding-error sliver (belongs on the discount chip),
 *  - or the remaining price is a sliver, which means the prices are bad data.
 */
export function computeCostSplit(
  originalPrice: number | null | undefined,
  offerPrice: number | null | undefined,
  requiredPeople: number | null | undefined,
): CostSplit | null {
  const original = Number(originalPrice);
  const offer = Number(offerPrice);
  const people = Number(requiredPeople);

  if (!Number.isFinite(original) || !Number.isFinite(offer) || original <= 0) {
    return null;
  }
  if (!Number.isFinite(people) || people < 2) return null;
  if (offer <= 0 || offer >= original) return null;

  const paidFraction = offer / original;
  const savingFraction = 1 - paidFraction;
  if (
    paidFraction < MIN_PAID_FRACTION ||
    savingFraction < MIN_SAVING_FRACTION
  ) {
    return null;
  }

  const groupSize = Math.round(people);
  const perPersonSaving = original - offer;

  return {
    actualPriceLabel: formatPrice(original),
    yourShareLabel: formatPrice(offer),
    yourSavingLabel: formatPrice(perPersonSaving),
    groupSavingLabel: formatPrice(perPersonSaving * groupSize),
    groupSavingLead: groupSize === 2 ? 'You Both Save' : 'You All Save',
    groupSavingWorking: `${groupSize} × ${formatPrice(perPersonSaving)}`,
  };
}

export function isCostSplitEligible(
  originalPrice: number | null | undefined,
  offerPrice: number | null | undefined,
  requiredPeople: number | null | undefined,
): boolean {
  return computeCostSplit(originalPrice, offerPrice, requiredPeople) !== null;
}

function formatPrice(value: number): string {
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
}

export interface DiscountBadgeText {
  /** Small caption above the figure. */
  caption: string;
  /** e.g. "20%" — the discount percentage, without the " OFF" suffix. */
  value: string;
}

/**
 * The circular badge over the hero photo.
 *
 * Lives here rather than as a literal inside the SVG because the caption and
 * the figure have to agree, and they did not: the caption read "YOU PAY ONLY"
 * above a DISCOUNT percentage, so a ₹10,000 → ₹8,000 offer announced "YOU PAY
 * ONLY 20%" when the customer pays 80%. Like the group-savings bug above, it
 * was self-consistent at exactly 50% off and wrong everywhere else.
 */
export function buildDiscountBadgeText(
  discountLabel: string | null | undefined,
): DiscountBadgeText | null {
  if (typeof discountLabel !== 'string' || discountLabel.trim() === '') {
    return null;
  }
  return { caption: 'YOU SAVE', value: discountLabel.replace(' OFF', '') };
}

export interface UnlockStep {
  title: string;
  body: string;
}

/**
 * The 3-step unlock diagram. Fixed, not per-offer — reviewed once here
 * rather than generated per render, same reasoning as the Pairley copy
 * catalog. Step 2's wording follows the same load-bearing rule as that
 * catalog: it states the *condition* ("when N people show interest"), never
 * promises the group will complete.
 */
export function buildUnlockSteps(
  requiredPeople: number | null | undefined,
): UnlockStep[] {
  const people = Number(requiredPeople);
  const groupSize =
    Number.isFinite(people) && people >= 2 ? Math.round(people) : 2;
  const othersPhrase =
    groupSize - 1 === 1 ? 'one more person' : `${groupSize - 1} more people`;

  return [
    { title: 'Show Interest', body: "Let the shop know you're interested." },
    {
      title: groupSize - 1 === 1 ? 'Offer Partner Does Too' : 'Others Join Too',
      body: `When ${othersPhrase} also show interest, the deal unlocks.`,
    },
    {
      title: 'Unlock & Enjoy',
      body: 'Once unlocked, coordinate and enjoy the offer together.',
    },
  ];
}

/**
 * Why-Pairley bullets. The first three are brand-level claims true of
 * Pairley itself, safe on every banner. "Verified Local Partner" is
 * withheld for an unclaimed, AI-discovered business — it hasn't joined
 * Pairley yet, so claiming a trust relationship that doesn't exist yet
 * would be exactly the kind of overclaim Phase 3B's badge rules already
 * refuse to make (see bannerLayout.ts's decideBadge: EXCLUSIVE is refused
 * on imported offers for the same reason).
 */
export function buildWhyPairleyBullets(
  businessStatus: string | null | undefined,
  merchantVerified: boolean | undefined,
): string[] {
  const bullets = [
    'Better Deals Together',
    'Pay Less, Enjoy More',
    'Safe. Simple. Smart.',
  ];
  if (merchantVerified || businessStatus === BusinessStatus.CLAIMED) {
    bullets.splice(2, 0, 'Verified Local Partner');
  }
  return bullets;
}

const DEFAULT_WEB_URL = 'https://pairley.com';

/**
 * The deal-page URL the QR code encodes. `PAIRLEY_WEB_URL` lets this point
 * at a staging domain without a code change; falls back to the production
 * domain already used elsewhere in this codebase (whatsapp.service.ts's
 * outbound message templates).
 */
export function buildDealUrl(
  offerId: string | null | undefined,
): string | null {
  if (!offerId) return null;
  const base = process.env.PAIRLEY_WEB_URL || DEFAULT_WEB_URL;
  return `${base.replace(/\/+$/, '')}/deals/${offerId}`;
}
