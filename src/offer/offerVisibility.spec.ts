import { BusinessStatus } from '@prisma/client';
import {
  PUBLIC_OFFER_FIELDS,
  OWNER_ONLY_OFFER_FIELDS,
  PUBLIC_BUSINESS_SELECT,
  CONTACT_BUSINESS_SELECT,
  resolveContactAccess,
  resolveLeadFollowupMode,
  buildBusinessSelect,
  decorateBusinessContact,
  isOwner,
  isAdmin,
} from './offerVisibility';

const CLAIMED = { business_status: BusinessStatus.CLAIMED };
const UNCLAIMED = { business_status: BusinessStatus.UNCLAIMED };

const ANON = {};
const CUSTOMER = {
  userId: 'cust-1',
  role: 'Customer',
  ownerBusinessId: 'biz-1',
};
const OTHER_BUSINESS = {
  userId: 'biz-9',
  role: 'Business',
  ownerBusinessId: 'biz-1',
};
const OWNER = { userId: 'biz-1', role: 'Business', ownerBusinessId: 'biz-1' };
const ADMIN = { userId: 'admin-1', role: 'Admin', ownerBusinessId: 'biz-1' };

describe('offerVisibility (Module 14 Phase 3A — contact protection)', () => {
  describe('field projections', () => {
    // The regression this whole module exists to prevent.
    it('keeps every direct contact channel out of the public offer projection', () => {
      const keys = Object.keys(PUBLIC_OFFER_FIELDS);
      expect(keys).not.toContain('whatsapp_number');
    });

    it('keeps provenance fields out of the public offer projection', () => {
      const keys = Object.keys(PUBLIC_OFFER_FIELDS);
      [
        'source',
        'confidence_score',
        'imported_at',
        'review_required',
        'original_import_url',
        'original_import_source',
        'merchant_verified',
        'is_pairley_exclusive',
        'original_poster',
        'generated_offer_card',
      ].forEach((field) => expect(keys).not.toContain(field));
    });

    it('still exposes everything a customer needs to evaluate an offer', () => {
      const keys = Object.keys(PUBLIC_OFFER_FIELDS);
      [
        'title',
        'description',
        'offer_type',
        'category',
        'original_price',
        'offer_price',
        'required_people',
        'joined_people',
        'start_date',
        'end_date',
        'cover_image',
        'gallery_images',
      ].forEach((field) => expect(keys).toContain(field));
    });

    it('routes whatsapp_number to the owner-only projection', () => {
      expect(Object.keys(OWNER_ONLY_OFFER_FIELDS)).toContain('whatsapp_number');
    });

    it('keeps contact columns out of the public business projection', () => {
      const keys = Object.keys(PUBLIC_BUSINESS_SELECT);
      [
        'mobile',
        'email',
        'owner_name',
        'address',
        'whatsapp',
        'support_number',
      ].forEach((field) => expect(keys).not.toContain(field));
    });

    it('exposes only coarse location publicly — city/state/mall, never street address', () => {
      const keys = Object.keys(PUBLIC_BUSINESS_SELECT);
      expect(keys).toContain('city');
      expect(keys).toContain('state');
      expect(keys).toContain('mall_name');
      expect(keys).not.toContain('address');
      expect(keys).not.toContain('pincode');
    });

    // The merchant's own front door is public information, independent of
    // the contact-reveal policy — a customer can always find it.
    it('keeps website public so a merchant stays reachable on their own terms', () => {
      expect(Object.keys(PUBLIC_BUSINESS_SELECT)).toContain('website');
    });

    it('never overlaps the public and contact business projections', () => {
      const publicKeys = Object.keys(PUBLIC_BUSINESS_SELECT);
      Object.keys(CONTACT_BUSINESS_SELECT).forEach((field) =>
        expect(publicKeys).not.toContain(field),
      );
    });
  });

  describe('resolveLeadFollowupMode', () => {
    it('defaults to ADMIN_MANAGED for an unset value', () => {
      expect(resolveLeadFollowupMode(undefined)).toBe('ADMIN_MANAGED');
      expect(resolveLeadFollowupMode(null)).toBe('ADMIN_MANAGED');
      expect(resolveLeadFollowupMode('')).toBe('ADMIN_MANAGED');
    });

    it('accepts MERCHANT_MANAGED explicitly', () => {
      expect(resolveLeadFollowupMode('MERCHANT_MANAGED')).toBe(
        'MERCHANT_MANAGED',
      );
    });

    // A typo'd env var must degrade to the safer (no-reveal) default, not
    // throw and not silently do the more permissive thing.
    it('degrades an unrecognised value to ADMIN_MANAGED rather than throwing', () => {
      expect(resolveLeadFollowupMode('merchant_managed')).toBe('ADMIN_MANAGED');
      expect(resolveLeadFollowupMode('SOMETHING_ELSE')).toBe('ADMIN_MANAGED');
    });
  });

  describe('resolveContactAccess', () => {
    it('refuses an anonymous caller in either mode', () => {
      expect(
        resolveContactAccess(ANON, CLAIMED, true, 'ADMIN_MANAGED'),
      ).toEqual({
        canSeeContact: false,
        notice: 'SIGN_UP_REQUIRED',
      });
      expect(
        resolveContactAccess(ANON, CLAIMED, true, 'MERCHANT_MANAGED'),
      ).toEqual({
        canSeeContact: false,
        notice: 'SIGN_UP_REQUIRED',
      });
    });

    it('allows the owning business and an admin regardless of mode', () => {
      expect(
        resolveContactAccess(OWNER, UNCLAIMED, false, 'ADMIN_MANAGED')
          .canSeeContact,
      ).toBe(true);
      expect(
        resolveContactAccess(OWNER, UNCLAIMED, false, 'MERCHANT_MANAGED')
          .canSeeContact,
      ).toBe(true);
      expect(
        resolveContactAccess(ADMIN, UNCLAIMED, false, 'ADMIN_MANAGED')
          .canSeeContact,
      ).toBe(true);
    });

    // A logged-in business account is not special-cased — on a listing it
    // doesn't own, it's treated exactly like any other authenticated
    // non-owner, refused here because the business isn't CLAIMED (not
    // because of who's asking).
    it('refuses a different business viewing an unclaimed listing, same as any customer', () => {
      expect(
        resolveContactAccess(
          OTHER_BUSINESS,
          UNCLAIMED,
          true,
          'MERCHANT_MANAGED',
        ).canSeeContact,
      ).toBe(false);
    });

    it('defaults to ADMIN_MANAGED when no mode is given', () => {
      expect(resolveContactAccess(CUSTOMER, CLAIMED, true)).toEqual({
        canSeeContact: false,
        notice: 'NOT_SHARED',
      });
    });

    describe('ADMIN_MANAGED mode (Diwali launch default)', () => {
      // The whole point of this mode: Pairley captures the lead and the
      // admin/merchant follow up manually — contact is never handed to a
      // customer through this endpoint, regardless of business status or
      // expressed interest.
      it('never shares contact with a signed-in customer, on any business status or interest state', () => {
        expect(
          resolveContactAccess(CUSTOMER, CLAIMED, true, 'ADMIN_MANAGED'),
        ).toEqual({
          canSeeContact: false,
          notice: 'NOT_SHARED',
        });
        expect(
          resolveContactAccess(CUSTOMER, UNCLAIMED, false, 'ADMIN_MANAGED'),
        ).toEqual({
          canSeeContact: false,
          notice: 'NOT_SHARED',
        });
      });
    });

    describe('MERCHANT_MANAGED mode (future, disabled by default)', () => {
      it('allows a signed-in customer on a CLAIMED business who has expressed interest', () => {
        expect(
          resolveContactAccess(CUSTOMER, CLAIMED, true, 'MERCHANT_MANAGED'),
        ).toEqual({
          canSeeContact: true,
          notice: 'AVAILABLE',
        });
      });

      it('withholds contact from a CLAIMED business until interest is expressed', () => {
        expect(
          resolveContactAccess(CUSTOMER, CLAIMED, false, 'MERCHANT_MANAGED'),
        ).toEqual({
          canSeeContact: false,
          notice: 'SHOW_INTEREST_REQUIRED',
        });
      });

      // Nobody has verified there's a real owner able to receive the call —
      // this holds regardless of interest.
      it('refuses contact for an UNCLAIMED business regardless of interest, pointing at their own site', () => {
        expect(
          resolveContactAccess(CUSTOMER, UNCLAIMED, false, 'MERCHANT_MANAGED'),
        ).toEqual({
          canSeeContact: false,
          notice: 'USE_OFFICIAL_WEBSITE',
        });
        expect(
          resolveContactAccess(CUSTOMER, UNCLAIMED, true, 'MERCHANT_MANAGED'),
        ).toEqual({
          canSeeContact: false,
          notice: 'USE_OFFICIAL_WEBSITE',
        });
      });

      it('treats a missing/unknown business as not claimed', () => {
        expect(
          resolveContactAccess(CUSTOMER, null, true, 'MERCHANT_MANAGED')
            .canSeeContact,
        ).toBe(false);
        expect(
          resolveContactAccess(CUSTOMER, {}, true, 'MERCHANT_MANAGED')
            .canSeeContact,
        ).toBe(false);
      });
    });
  });

  describe('isOwner / isAdmin', () => {
    it('matches only when the viewer id equals the owning business id', () => {
      expect(isOwner(OWNER)).toBe(true);
      expect(isOwner(OTHER_BUSINESS)).toBe(false);
      expect(isOwner(CUSTOMER)).toBe(false);
    });

    it('is never true for an anonymous viewer, even with a missing owner id', () => {
      expect(isOwner({})).toBe(false);
      expect(isOwner({ userId: undefined, ownerBusinessId: undefined })).toBe(
        false,
      );
    });

    it('identifies admins by role', () => {
      expect(isAdmin(ADMIN)).toBe(true);
      expect(isAdmin(CUSTOMER)).toBe(false);
      expect(isAdmin({})).toBe(false);
    });
  });

  describe('buildBusinessSelect', () => {
    it('adds contact columns only when access allows', () => {
      const allowed = buildBusinessSelect({
        canSeeContact: true,
        notice: 'AVAILABLE',
      });
      expect(allowed).toHaveProperty('mobile');
      expect(allowed).toHaveProperty('email');
      expect(allowed).toHaveProperty('business_name');
    });

    it('omits contact columns from the query entirely when access is denied', () => {
      const denied = buildBusinessSelect({
        canSeeContact: false,
        notice: 'SIGN_UP_REQUIRED',
      });
      expect(denied).not.toHaveProperty('mobile');
      expect(denied).not.toHaveProperty('email');
      expect(denied).not.toHaveProperty('owner_name');
      expect(denied).not.toHaveProperty('address');
      expect(denied).toHaveProperty('business_name');
    });
  });

  describe('decorateBusinessContact', () => {
    it('annotates the payload so the UI can explain the absence', () => {
      const result = decorateBusinessContact(
        { business_name: 'Spec Gym' },
        {
          canSeeContact: false,
          notice: 'SIGN_UP_REQUIRED',
        },
      );
      expect(result).toEqual({
        business_name: 'Spec Gym',
        contact_available: false,
        contact_notice: 'SIGN_UP_REQUIRED',
      });
    });

    it('never invents contact fields it wasn’t given', () => {
      const result = decorateBusinessContact(
        { business_name: 'Spec Gym' },
        {
          canSeeContact: true,
          notice: 'AVAILABLE',
        },
      );
      expect(result).not.toHaveProperty('mobile');
    });

    it('passes a null business straight through', () => {
      expect(
        decorateBusinessContact(null, {
          canSeeContact: false,
          notice: 'SIGN_UP_REQUIRED',
        }),
      ).toBeNull();
    });
  });
});
