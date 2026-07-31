import { Injectable } from '@nestjs/common';
import {
  BusinessStatus,
  OfferStatus,
  OfferType,
  Prisma,
  Source,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface DraftBusinessFields {
  merchantName: string;
  mobile?: string | null;
  email?: string | null;
  category?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  area?: string | null;
  googleMapsLink?: string | null;
}

/**
 * The "find-or-create an UNCLAIMED merchant, then attach a DRAFT offer to
 * it" logic every admin-driven offer-creation path needs — originally
 * written once, inline, inside bulk-import's row-processing loop
 * (BulkImportService.createDraftForRow). Extracted here, into OfferModule
 * rather than left in bulk-import, specifically so it survives independently
 * of whichever admin-facing tool is currently calling it — bulk-import and
 * the image-first Offer Publisher both need the exact same "who is this
 * merchant, and are they new" decision, and bulk-import itself is not meant
 * to be a permanent fixture.
 *
 * A bulk-imported (or Offer-Publisher-created) merchant is always UNCLAIMED,
 * never a special "admin-curated" status — identical to any other
 * undiscovered business until the real owner claims it through the existing
 * OTP flow. See offerVisibility.ts's module docstring for why that matters
 * for contact-reveal policy.
 */
@Injectable()
export class OfferDraftCreationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Finds an existing business by phone, or creates a new UNCLAIMED one.
   * Every NOT NULL column on Business is satisfied even when the caller
   * supplies almost nothing — callers fill in the real values later via
   * their own update path; this only needs to produce a valid row.
   *
   * Accepts an optional Prisma transaction client so a caller that needs
   * this atomic with its own writes (bulk-import creating the Offer right
   * after) can pass its `tx`; defaults to the plain PrismaService for
   * callers (like Offer Publisher's single-image endpoint) that don't need
   * cross-table atomicity — a match-then-create race here only risks a
   * harmless duplicate Business row, never data loss.
   */
  async matchOrCreateBusiness(
    fields: DraftBusinessFields,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<{ businessId: string; created: boolean }> {
    const mobile = fields.mobile?.trim() || null;

    if (mobile) {
      const existing = await client.business.findUnique({
        where: { mobile },
        select: { id: true },
      });
      if (existing) return { businessId: existing.id, created: false };
    }

    const business = await client.business.create({
      data: {
        owner_name: fields.merchantName,
        business_name: fields.merchantName,
        business_type: fields.category || '',
        category: fields.category || '',
        mobile,
        email: fields.email?.trim() || null,
        address: fields.address || '',
        city: fields.city || '',
        state: fields.state || '',
        pincode: fields.pincode || '',
        area: fields.area || null,
        google_maps_link: fields.googleMapsLink || null,
        business_status: BusinessStatus.UNCLAIMED,
        source: Source.ADMIN,
      },
    });
    return { businessId: business.id, created: true };
  }

  /**
   * The Offer Publisher's Step 1 case: an image has been uploaded and
   * nothing else is known yet — no merchant name, no title, nothing. Creates
   * a brand-new placeholder business + a DRAFT offer with the cover image
   * already attached, so the admin has a real, editable row to fill in on
   * Step 2 rather than holding unattached state client-side.
   */
  async createPlaceholderDraft(
    coverImageUrl: string,
  ): Promise<{ businessId: string; offerId: string }> {
    const now = new Date();
    const thirtyDaysOut = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    return this.prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          owner_name: '',
          business_name: 'Untitled Merchant',
          business_type: '',
          category: '',
          address: '',
          city: '',
          state: '',
          pincode: '',
          business_status: BusinessStatus.UNCLAIMED,
          source: Source.ADMIN,
        },
      });

      const offer = await tx.offer.create({
        data: {
          business_id: business.id,
          title: 'Untitled offer',
          description: '',
          offer_type: OfferType.STANDARD,
          category: '',
          original_price: 0,
          offer_price: 0,
          required_people: 1,
          start_date: now,
          end_date: thirtyDaysOut,
          cover_image: coverImageUrl,
          status: OfferStatus.DRAFT,
          source: Source.ADMIN,
        },
      });

      return { businessId: business.id, offerId: offer.id };
    });
  }
}
