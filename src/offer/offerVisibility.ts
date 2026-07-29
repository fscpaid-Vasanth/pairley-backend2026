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
 * on its own, independently of Prisma or the request pipeline.
 */

/** What the caller is, as far as visibility decisions are concerned. */
export interface ViewerContext {
  userId?: string;
  role?: string;
  /** The business that owns the offer being viewed. */
  ownerBusinessId?: string;
}

export type ContactNotice =
  /** Not logged in — contact is gated behind signup. */
  | 'SIGN_UP_REQUIRED'
  /**
   * The business hasn't claimed its Pairley listing. Its contact details
   * are its own published information, so Pairley doesn't present itself as
   * the gatekeeper to them — the customer is pointed at the merchant's own
   * site instead, and the merchant is invited to claim the listing.
   */
  | 'USE_OFFICIAL_WEBSITE'
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
 * front door, and it's what the USE_OFFICIAL_WEBSITE notice points at.
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
 *  2. Anonymous — never. This is the gap Phase 3A closes.
 *  3. Unclaimed business — never, for anyone else. The merchant hasn't
 *     agreed to be on Pairley, so Pairley shouldn't act as the channel to
 *     them; point at their own site instead.
 *  4. Authenticated viewer, claimed business — allowed, per the existing
 *     access and communication rules.
 */
export function resolveContactAccess(
  viewer: ViewerContext,
  business: { business_status?: BusinessStatus | string | null } | null,
): ContactAccess {
  if (isOwner(viewer) || isAdmin(viewer)) {
    return { canSeeContact: true, notice: 'AVAILABLE' };
  }

  if (!viewer.userId) {
    return { canSeeContact: false, notice: 'SIGN_UP_REQUIRED' };
  }

  if (business?.business_status !== BusinessStatus.CLAIMED) {
    return { canSeeContact: false, notice: 'USE_OFFICIAL_WEBSITE' };
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
