import { BusinessStatus } from '@prisma/client';
import {
  PUBLIC_OFFER_FIELDS,
  OWNER_ONLY_OFFER_FIELDS,
  PUBLIC_BUSINESS_SELECT,
  CONTACT_BUSINESS_SELECT,
  resolveContactAccess,
  buildBusinessSelect,
  decorateBusinessContact,
  isOwner,
  isAdmin,
} from './offerVisibility';

const CLAIMED = { business_status: BusinessStatus.CLAIMED };
const UNCLAIMED = { business_status: BusinessStatus.UNCLAIMED };

const ANON = {};
const CUSTOMER = { userId: 'cust-1', role: 'Customer', ownerBusinessId: 'biz-1' };
const OTHER_BUSINESS = { userId: 'biz-9', role: 'Business', ownerBusinessId: 'biz-1' };
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
      ['mobile', 'email', 'owner_name', 'address', 'whatsapp', 'support_number'].forEach(
        (field) => expect(keys).not.toContain(field),
      );
    });

    it('exposes only coarse location publicly — city/state/mall, never street address', () => {
      const keys = Object.keys(PUBLIC_BUSINESS_SELECT);
      expect(keys).toContain('city');
      expect(keys).toContain('state');
      expect(keys).toContain('mall_name');
      expect(keys).not.toContain('address');
      expect(keys).not.toContain('pincode');
    });

    // The merchant's own front door is public information and is what the
    // USE_OFFICIAL_WEBSITE notice points a customer at.
    it('keeps website public so an unclaimed merchant stays reachable on their own terms', () => {
      expect(Object.keys(PUBLIC_BUSINESS_SELECT)).toContain('website');
    });

    it('never overlaps the public and contact business projections', () => {
      const publicKeys = Object.keys(PUBLIC_BUSINESS_SELECT);
      Object.keys(CONTACT_BUSINESS_SELECT).forEach((field) =>
        expect(publicKeys).not.toContain(field),
      );
    });
  });

  describe('resolveContactAccess', () => {
    it('refuses an anonymous caller — the gap this phase closes', () => {
      expect(resolveContactAccess(ANON, CLAIMED)).toEqual({
        canSeeContact: false,
        notice: 'SIGN_UP_REQUIRED',
      });
    });

    it('refuses an anonymous caller on an unclaimed business too', () => {
      expect(resolveContactAccess(ANON, UNCLAIMED).canSeeContact).toBe(false);
    });

    it('allows an authenticated customer on a claimed business', () => {
      expect(resolveContactAccess(CUSTOMER, CLAIMED)).toEqual({
        canSeeContact: true,
        notice: 'AVAILABLE',
      });
    });

    // Pairley shouldn't present itself as the gatekeeper to a number the
    // merchant publishes themselves and never agreed to route through us.
    it('refuses contact for an unclaimed business, pointing at their own site', () => {
      expect(resolveContactAccess(CUSTOMER, UNCLAIMED)).toEqual({
        canSeeContact: false,
        notice: 'USE_OFFICIAL_WEBSITE',
      });
    });

    it('allows the owning business', () => {
      expect(resolveContactAccess(OWNER, UNCLAIMED).canSeeContact).toBe(true);
      expect(resolveContactAccess(OWNER, CLAIMED).canSeeContact).toBe(true);
    });

    it('allows an admin regardless of claim status', () => {
      expect(resolveContactAccess(ADMIN, UNCLAIMED).canSeeContact).toBe(true);
    });

    // A logged-in merchant is not entitled to a competitor's contact details
    // just for being authenticated.
    it('refuses a different business viewing someone else’s unclaimed listing', () => {
      expect(resolveContactAccess(OTHER_BUSINESS, UNCLAIMED).canSeeContact).toBe(false);
    });

    it('treats a missing/unknown business as not claimed', () => {
      expect(resolveContactAccess(CUSTOMER, null).canSeeContact).toBe(false);
      expect(resolveContactAccess(CUSTOMER, {}).canSeeContact).toBe(false);
      expect(
        resolveContactAccess(CUSTOMER, { business_status: null }).canSeeContact,
      ).toBe(false);
    });

    it('does not treat a REMOVED business as claimed', () => {
      expect(
        resolveContactAccess(CUSTOMER, { business_status: BusinessStatus.REMOVED })
          .canSeeContact,
      ).toBe(false);
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
      expect(isOwner({ userId: undefined, ownerBusinessId: undefined })).toBe(false);
    });

    it('identifies admins by role', () => {
      expect(isAdmin(ADMIN)).toBe(true);
      expect(isAdmin(CUSTOMER)).toBe(false);
      expect(isAdmin({})).toBe(false);
    });
  });

  describe('buildBusinessSelect', () => {
    it('adds contact columns only when access allows', () => {
      const allowed = buildBusinessSelect({ canSeeContact: true, notice: 'AVAILABLE' });
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
      const result = decorateBusinessContact({ business_name: 'Spec Gym' }, {
        canSeeContact: false,
        notice: 'SIGN_UP_REQUIRED',
      });
      expect(result).toEqual({
        business_name: 'Spec Gym',
        contact_available: false,
        contact_notice: 'SIGN_UP_REQUIRED',
      });
    });

    it('never invents contact fields it wasn’t given', () => {
      const result = decorateBusinessContact({ business_name: 'Spec Gym' }, {
        canSeeContact: true,
        notice: 'AVAILABLE',
      });
      expect(result).not.toHaveProperty('mobile');
    });

    it('passes a null business straight through', () => {
      expect(
        decorateBusinessContact(null, { canSeeContact: false, notice: 'SIGN_UP_REQUIRED' }),
      ).toBeNull();
    });
  });
});
