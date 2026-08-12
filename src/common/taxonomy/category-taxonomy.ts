// Canonical category taxonomy — the single semantic source of truth for
// every category string stored anywhere in Pairley (Offer.category,
// Business.category, and, from Milestone 2, Demand.category).
//
// WHY THIS IS A CODE CONSTANT AND NOT A DATABASE TABLE
// ----------------------------------------------------
// The Platform 2.0 architecture originally proposed a `CategoryTaxonomy`
// table. That was written before discovering that the frontend already
// owns a taxonomy at src/data/categories.js — 12 categories with icons,
// colours, gradients, hero images and copy, consumed by 17 components.
//
// Adding a DB table alongside that file would create two sources of truth
// for the same list, which is precisely the duplication the production-
// readiness rules forbid. So the boundary is drawn by concern instead:
//
//   • This file owns the SEMANTIC taxonomy — which keys exist, what they
//     are called, and whether they may be aggregated. The backend
//     validates and normalises against it.
//   • src/data/categories.js owns PRESENTATION — icon, colour, gradient,
//     image, description, pair/group mode.
//
// Both are keyed by the same string. That is a shared enum across a
// boundary, not a duplicated table. The contract is enforced by
// category.service.spec.ts, which fails if the two lists drift apart.
//
// Categories are deploy-time configuration, not runtime data: adding one
// requires frontend presentation assets anyway, so a DB row alone could
// never fully add a category. Market Intelligence THRESHOLDS are the
// genuinely runtime-tunable part, and those do live in the database
// (MarketIntelligenceConfig) exactly as specified.

export interface CanonicalCategory {
  /** Stable storage key. Never change one without a backfill. */
  key: string;
  /** Human label for UI and admin tooling. Safe to change any time. */
  displayName: string;
  /**
   * Whether this category may take part in Market Price Intelligence
   * aggregation. `general` is a holding pen for records whose real
   * category is not yet known — averaging prices across it would blend
   * unrelated products into a meaningless "market rate".
   */
  aggregatable: boolean;
  /**
   * Whether this category is offered in pickers. `general` is valid to
   * store but must never be a thing a merchant deliberately chooses.
   */
  selectable: boolean;
}

export const CANONICAL_CATEGORIES: readonly CanonicalCategory[] = [
  { key: 'shopping',      displayName: 'Shopping',               aggregatable: true,  selectable: true },
  { key: 'tours',         displayName: 'Tour Packages',          aggregatable: true,  selectable: true },
  { key: 'dining',        displayName: 'Dining & Food',          aggregatable: true,  selectable: true },
  { key: 'fitness',       displayName: 'Fitness & Gym',          aggregatable: true,  selectable: true },
  { key: 'entertainment', displayName: 'Events & Entertainment', aggregatable: true,  selectable: true },
  { key: 'education',     displayName: 'Education & Courses',    aggregatable: true,  selectable: true },
  { key: 'beauty',        displayName: 'Beauty & Spa',           aggregatable: true,  selectable: true },
  { key: 'subscriptions', displayName: 'Subscriptions & OTT',    aggregatable: true,  selectable: true },
  { key: 'adventure',     displayName: 'Adventure & Sports',     aggregatable: true,  selectable: true },
  { key: 'home-services', displayName: 'Home Services',          aggregatable: true,  selectable: true },
  { key: 'healthcare',    displayName: 'Healthcare',             aggregatable: true,  selectable: true },
  { key: 'coworking',     displayName: 'Co-Working & Stays',     aggregatable: true,  selectable: true },

  // Holding pen. auth.service.ts has historically defaulted new business
  // records to the literal 'General' when no category was supplied, and
  // Offer Publisher creates placeholder businesses before the category is
  // known. Those are legitimate states, so `general` is a real key rather
  // than a validation failure — but it is excluded from both pickers and
  // price aggregation.
  { key: 'general',       displayName: 'Uncategorized',          aggregatable: false, selectable: false },
] as const;

export const UNCATEGORIZED_KEY = 'general';

/**
 * Legacy and colloquial spellings mapped onto canonical keys. Exact-key
 * and display-name matching are handled generically by CategoryService;
 * this table is only for values that neither of those would catch.
 *
 * Everything here is lowercased before lookup.
 */
export const CATEGORY_ALIASES: Readonly<Record<string, string>> = {
  gym: 'fitness',
  gyms: 'fitness',
  'fitness and gym': 'fitness',
  'fitness/gym': 'fitness',
  health: 'healthcare',
  medical: 'healthcare',
  food: 'dining',
  restaurant: 'dining',
  restaurants: 'dining',
  'dining and food': 'dining',
  buffet: 'dining',
  cafe: 'dining',
  // The AI Offer Collector's source-site category text arrives as one
  // slash-joined label, not Pairley's own taxonomy — this exact string is
  // what production logged as "Unknown category" (2026-08-12).
  'restaurants/buffets': 'dining',
  travel: 'tours',
  tour: 'tours',
  'tour package': 'tours',
  trips: 'tours',
  'travel/tours': 'tours',
  salon: 'beauty',
  spa: 'beauty',
  'beauty and spa': 'beauty',
  'spa/salon': 'beauty',
  events: 'entertainment',
  movies: 'entertainment',
  'events and entertainment': 'entertainment',
  courses: 'education',
  'education and courses': 'education',
  'education/training': 'education',
  retail: 'shopping',
  shop: 'shopping',
  'shopping/retail': 'shopping',
  ott: 'subscriptions',
  subscription: 'subscriptions',
  sports: 'adventure',
  'adventure and sports': 'adventure',
  home: 'home-services',
  'home service': 'home-services',
  coliving: 'coworking',
  'co-working': 'coworking',
  'co working': 'coworking',
  uncategorized: UNCATEGORIZED_KEY,
  uncategorised: UNCATEGORIZED_KEY,
  other: UNCATEGORIZED_KEY,
  misc: UNCATEGORIZED_KEY,
};
