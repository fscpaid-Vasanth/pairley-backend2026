import { BusinessStatus } from '@prisma/client';

/**
 * Module 14 Phase 3A — merchant contact protection.
 *
 * Before this module, `GET /offers/details/:id` (OptionalJwtAuthGuard — no
 * login required) returned `business.mobile`, `business.email`,
 * `business.owner_name` and the full street `address` to *anonymous*
 * callers, for every offer on the platform. `Offer.whatsapp_number` leaked
 * the same way through both `listOffers` and `getOffersByCategory` (the
 * latter has no guard at all).
 *
 * The rule this file exists to enforce: **if a protected value is in the
 * JSON, it is public.** Masking in the frontend is presentation, not
 * protection — anyone can read the network response. So contact fields are
 * never selected for a viewer who isn't entitled to them, rather than being
 * selected and then blanked out.
 *
 * Everything here is pure and side-effect free so the policy can be tested
 * on its own, independently of Prisma or the request pipeline — including
 * reading LEAD_FOLLOWUP_MODE, which is why that's the *caller's* job
 * (offer.service.ts, via ConfigService) and arrives here as a plain
 * argument rather than this file reading process.env itself.
 *
 * Lead-generation revision — configurable follow-up mode. Pairley operates
 * in one of two modes, set platform-wide via the LEAD_FOLLOWUP_MODE
 * environment variable:
 *
 *  - ADMIN_MANAGED (the default, and the only mode used for the Diwali
 *    launch): contact is never handed to a customer through this endpoint
 *    at all, regardless of business status or expressed interest. Pairley
 *    captures the lead; the admin/merchant follow up manually.
 *  - MERCHANT_MANAGED (built, tested, deliberately left disabled by the
 *    default): restores the direct-reveal behavior — a CLAIMED business's
 *    contact unlocks for a signed-in customer once they've expressed
 *    interest in that specific offer. An UNCLAIMED business never reveals
 *    contact in either mode, since nobody has verified there's a real
 *    owner able to receive the call.
 *
 * The point of building both rather than only ADMIN_MANAGED: switching
 * later, when merchant adoption is mature, is an environment-variable
 * change, not a redesign — the entitlement logic and the frontend's
 * contact-display path (gated on `contact_available`, which this file
 * controls) already exist and are already tested.
 */

export type LeadFollowupMode = 'ADMIN_MANAGED' | 'MERCHANT_MANAGED';

const DEFAULT_LEAD_FOLLOWUP_MODE: LeadFollowupMode = 'ADMIN_MANAGED';

/**
 * Validates and defaults an env-var value into a real mode — never throws,
 * so a typo'd or unset environment variable degrades to the safer default
 * (no contact reveal) rather than failing the request or silently doing
 * the more permissive thing.
 */
export function resolveLeadFollowupMode(
  raw: string | null | undefined,
): LeadFollowupMode {
  return raw === 'MERCHANT_MANAGED'
    ? 'MERCHANT_MANAGED'
    : DEFAULT_LEAD_FOLLOWUP_MODE;
}

/** What the caller is, as far as visibility decisions are concerned. */
export interface ViewerContext {
  userId?: string;
  role?: string;
  /** The business that owns the offer being viewed. */
  ownerBusinessId?: string;
}

export type ContactNotice =
  /** Not logged in. */
  | 'SIGN_UP_REQUIRED'
  /**
   * ADMIN_MANAGED mode: signed in, but not the owner/admin — Pairley
   * captures the lead and the merchant/admin follows up manually; contact
   * is never handed to a customer through this endpoint in this mode.
   */
  | 'NOT_SHARED'
  /**
   * MERCHANT_MANAGED mode only: the business hasn't claimed its Pairley
   * listing, so nobody has verified there's a real owner able to receive
   * the call — point the customer at the merchant's own published site
   * instead (see PUBLIC_BUSINESS_SELECT's `website`).
   */
  | 'USE_OFFICIAL_WEBSITE'
  /**
   * MERCHANT_MANAGED mode only: signed in, entitled (CLAIMED) business,
   * but this viewer hasn't expressed interest in THIS offer yet — contact
   * unlocks by asking, not by merely opening the page.
   */
  | 'SHOW_INTEREST_REQUIRED'
  /** Caller is entitled to see the contact details. */
  | 'AVAILABLE';

export interface ContactAccess {
  canSeeContact: boolean;
  notice: ContactNotice;
}

/**
 * Offer scalar fields safe for public/customer-facing reads.
 *
 * Excludes `source` and every Pairley 2.0 provenance field
 * (confidence_score, imported_at, review_required, original_import_url,
 * original_import_source, merchant_verified, is_pairley_exclusive,
 * original_poster, generated_offer_card) — customers must never see
 * whether or how an offer was imported, only the computed `badge`.
 *
 * Phase 3A additionally removes `whatsapp_number`: it is a direct merchant
 * contact channel and belongs with mobile/email, not in a public list
 * response. Owners still receive it (see OWNER_ONLY_OFFER_FIELDS).
 */
export const PUBLIC_OFFER_FIELDS = {
  id: true,
  business_id: true,
  title: true,
  description: true,
  offer_type: true,
  category: true,
  original_price: true,
  offer_price: true,
  required_people: true,
  joined_people: true,
  start_date: true,
  end_date: true,
  status: true,
  offer_image: true,
  facility_images: true,
  facility_details: true,
  cover_image: true,
  gallery_images: true,
  geo_lat: true,
  geo_lng: true,
  created_at: true,
  updated_at: true,
} as const;

/** Selected only when the caller owns the offer (or is an admin). */
export const OWNER_ONLY_OFFER_FIELDS = {
  whatsapp_number: true,
} as const;

/**
 * Business fields any viewer may see. Deliberately location-coarse:
 * city/state/mall_name locate the shop well enough to decide whether to
 * visit, without publishing the full street address.
 *
 * `geo_lat`/`geo_lng` stay public — a storefront's position is how
 * customers find it, the map view depends on it, and it was already public
 * via listOffers before this module.
 *
 * `website` stays public deliberately: it's the merchant's own published
 * front door, independent of the contact-reveal policy below (that policy
 * only ever covered mobile/email/address/whatsapp/support_number).
 */
export const PUBLIC_BUSINESS_SELECT = {
  id: true,
  business_name: true,
  city: true,
  state: true,
  mall_name: true,
  shop_photo: true,
  logo: true,
  geo_lat: true,
  geo_lng: true,
  business_status: true,
  website: true,
} as const;

/** Selected only for a viewer whose ContactAccess allows it. */
export const CONTACT_BUSINESS_SELECT = {
  owner_name: true,
  mobile: true,
  email: true,
  address: true,
  whatsapp: true,
  support_number: true,
} as const;

export function isOwner(viewer: ViewerContext): boolean {
  return Boolean(
    viewer.userId &&
    viewer.ownerBusinessId &&
    viewer.userId === viewer.ownerBusinessId,
  );
}

export function isAdmin(viewer: ViewerContext): boolean {
  return viewer.role === 'Admin';
}

/**
 * The single decision point for whether a caller may see merchant contact
 * details.
 *
 * Order matters:
 *  1. Owner / admin — always, they administer the record.
 *  2. Anonymous — never.
 *  3. ADMIN_MANAGED mode — never, for anyone but owner/admin. This is the
 *     whole point of the mode: Pairley is the only channel, by design.
 *  4. MERCHANT_MANAGED mode, business not CLAIMED — never; point at the
 *     merchant's own site instead.
 *  5. MERCHANT_MANAGED mode, CLAIMED, no expressed interest yet — not yet.
 *  6. MERCHANT_MANAGED mode, CLAIMED, expressed interest — allowed.
 */
export function resolveContactAccess(
  viewer: ViewerContext,
  business: { business_status?: string | null } | null,
  hasExpressedInterest: boolean,
  mode: LeadFollowupMode = DEFAULT_LEAD_FOLLOWUP_MODE,
): ContactAccess {
  if (isOwner(viewer) || isAdmin(viewer)) {
    return { canSeeContact: true, notice: 'AVAILABLE' };
  }

  if (!viewer.userId) {
    return { canSeeContact: false, notice: 'SIGN_UP_REQUIRED' };
  }

  if (mode === 'ADMIN_MANAGED') {
    return { canSeeContact: false, notice: 'NOT_SHARED' };
  }

  if (business?.business_status !== BusinessStatus.CLAIMED) {
    return { canSeeContact: false, notice: 'USE_OFFICIAL_WEBSITE' };
  }

  if (!hasExpressedInterest) {
    return { canSeeContact: false, notice: 'SHOW_INTEREST_REQUIRED' };
  }

  return { canSeeContact: true, notice: 'AVAILABLE' };
}

/**
 * The Prisma `select` for the business relation, given the viewer. Contact
 * columns are omitted from the query itself when not permitted — they never
 * enter the process, so they can't be leaked by a later refactor that
 * forgets to strip them.
 */
export function buildBusinessSelect(access: ContactAccess) {
  return access.canSeeContact
    ? { ...PUBLIC_BUSINESS_SELECT, ...CONTACT_BUSINESS_SELECT }
    : { ...PUBLIC_BUSINESS_SELECT };
}

/**
 * Annotates the business payload with what the UI needs to explain the
 * absence of contact details, without ever carrying the details themselves.
 */
export function decorateBusinessContact<
  T extends Record<string, unknown> | null | undefined,
>(business: T, access: ContactAccess) {
  if (!business) return business;
  return {
    ...business,
    contact_available: access.canSeeContact,
    contact_notice: access.notice,
  };
}
