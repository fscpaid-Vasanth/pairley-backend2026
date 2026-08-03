import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  PUBLIC_OFFER_FIELDS,
  OWNER_ONLY_OFFER_FIELDS,
  PUBLIC_BUSINESS_SELECT,
  resolveContactAccess,
  resolveLeadFollowupMode,
  buildBusinessSelect,
  decorateBusinessContact,
} from './offerVisibility';
import { NotificationService } from '../common/services/notification.service';
import { OtpService } from '../common/services/otp.service';
import { StorageService } from '../common/services/storage.service';
import { CategoryService } from '../common/taxonomy/category.service';
import {
  WhatsappService,
  resolveLeadWhatsappNumber,
} from '../whatsapp/whatsapp.service';
import { FileValidationService } from '../discovery/file-validation.service';
import { FileImportError } from '../discovery/file-import.errors';
import {
  OfferType,
  OfferStatus,
  InterestStatus,
  SubscriptionStatus,
  VerificationStatus,
  LeadStatus,
  LeadSource,
  BusinessStatus,
} from '@prisma/client';

// Legacy pair/group matching mechanics — kept working exactly as before.
// Everything else (STANDARD + the new mechanics) uses the simplified
// Show Interest -> Lead -> Merchant Dashboard flow with no OfferInterest/
// capacity tracking/chat.
const LEGACY_MATCHING_OFFER_TYPES = new Set([
  'BOGO',
  'BOGT',
  'GROUP_DISCOUNT',
  'BULK_PURCHASE',
  'MEMBERSHIP_CAMPAIGN',
  'PACKAGE_DEAL',
]);

// listOffers() row cap — see the comment at its call site for why this
// exists. 100 comfortably covers today's admin views without a UI change;
// MAX exists so a caller can never request an unbounded fetch even if a
// future page passes a huge explicit `limit`.
const DEFAULT_LIST_OFFERS_PAGE_SIZE = 100;
const MAX_LIST_OFFERS_PAGE_SIZE = 200;

// Backend equivalent of the frontend's src/utils/geo.js haversineDistance —
// kept separate rather than shared, since this file has no dependency on
// the frontend package and the formula is a handful of lines.
function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Single badge a customer ever sees for an offer's origin, computed
// server-side with a fixed priority — the raw fields driving it
// (merchant_verified/is_pairley_exclusive/source) never reach the client.
// Verified Merchant > Pairley Exclusive > Imported from Public Information.
// is_pairley_exclusive can be set today (admin-only, dormant — no UI calls
// it yet); merchant_verified/source stay at their defaults until Group B.
type OfferBadge = 'verified' | 'exclusive' | 'imported' | null;
function computeOfferBadge(offer: {
  merchant_verified: boolean;
  is_pairley_exclusive: boolean;
  source: string;
}): OfferBadge {
  if (offer.merchant_verified) return 'verified';
  if (offer.is_pairley_exclusive) return 'exclusive';
  if (offer.source !== 'MANUAL') return 'imported';
  return null;
}

// Module 14 Phase 3A — the public field/contact-visibility policy moved to
// offerVisibility.ts so it can be unit-tested on its own and so there is
// exactly one place that decides what a given viewer may see. See that file
// for why contact columns are omitted from the query rather than blanked
// out afterwards.

@Injectable()
export class OfferService {
  constructor(
    private prisma: PrismaService,
    private notificationService: NotificationService,
    private otpService: OtpService,
    private storageService: StorageService,
    private whatsappService: WhatsappService,
    private configService: ConfigService,
    private categoryService: CategoryService,
    private fileValidationService: FileValidationService,
  ) {}

  // uploadOfferMedia previously trusted the client-declared mimetype alone
  // before handing a file straight to storage — the Offer Publisher tool and
  // merchant KYC uploads both already validate actual file content the same
  // way (see business.service.ts's validateUpload for the identical fix);
  // this was the one remaining offer-image upload path without it.
  private validateUpload(file: Express.Multer.File): void {
    try {
      this.fileValidationService.validate({
        mimetype: file.mimetype,
        size: file.size,
        buffer: file.buffer,
      });
    } catch (err) {
      if (err instanceof FileImportError) {
        throw new BadRequestException(`File rejected: ${err.message}`);
      }
      throw err;
    }
  }

  async createOffer(businessId: string, data: any) {
    // 1. Verify business is verified
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      include: { subscriptions: true },
    });

    if (!business) {
      throw new NotFoundException('Business profile not found');
    }

    if (business.verification_status !== VerificationStatus.APPROVED) {
      throw new ForbiddenException(
        'Your business account has not been approved by the administrator yet.',
      );
    }

    // 2. Verify business has active subscription
    const activeSub = business.subscriptions.find(
      (sub) =>
        sub.status === SubscriptionStatus.ACTIVE &&
        new Date() < sub.expiry_date,
    );

    if (!activeSub) {
      throw new ForbiddenException(
        'An active subscription is required to publish offers.',
      );
    }

    // 3. Resolve effective location — offer override, else inherit from the
    // business (Module 2). No geolocation logic duplicated here.
    const geoLat = data.geo_lat ?? business.geo_lat ?? null;
    const geoLng = data.geo_lng ?? business.geo_lng ?? null;

    // 4. Create the offer. cover_image/gallery_images (Module 3 media model)
    // accept the legacy offer_image/facility_images field names as a fallback
    // input source for backward compatibility, but always write to the new
    // columns only — offer_image/facility_images are not written by new code.
    const offer = await this.prisma.offer.create({
      data: {
        business_id: businessId,
        title: data.title,
        description: data.description,
        offer_type: data.offer_type as OfferType,
        // Normalised, never stored raw — see CategoryService. Rejects an
        // unrecognised value rather than letting it fragment aggregation.
        category: this.categoryService.normalizeForStorage(data.category),
        original_price: parseFloat(data.original_price),
        offer_price: parseFloat(data.offer_price),
        required_people: parseInt(data.required_people),
        start_date: new Date(data.start_date),
        end_date: new Date(data.end_date),
        cover_image: data.cover_image || data.offer_image || null,
        gallery_images: data.gallery_images || data.facility_images || [],
        facility_details: data.facility_details || null,
        whatsapp_number: data.whatsapp_number || null,
        geo_lat: geoLat,
        geo_lng: geoLng,
        status: OfferStatus.ACTIVE, // Published directly as active for validated business
      },
    });

    // 5. Version history: initial snapshot
    await this.prisma.offerVersion.create({
      data: {
        offer_id: offer.id,
        version_no: 1,
        snapshot: offer as any,
        changed_by: businessId,
        change_type: 'CREATED',
      },
    });

    // Asynchronously notify all customers of the new deal
    this.prisma.customer
      .findMany({ select: { id: true } })
      .then((customers) => {
        customers.forEach((customer) => {
          this.notificationService
            .sendNotification(
              customer.id,
              'New Offer Posted!',
              `${business.business_name} posted: "${offer.title}". Tap to view!`,
              'NEW_DEAL',
            )
            .catch((err) => {});
        });
      })
      .catch((err) => {});

    return offer;
  }

  async updateOffer(businessId: string, offerId: string, data: any) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
    });
    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    if (offer.business_id !== businessId) {
      throw new ForbiddenException('You do not own this offer');
    }

    // Defense in depth on top of UpdateOfferDto's whitelist: status changes go
    // through updateOfferStatus() instead, and provenance/AI/admin fields are
    // never merchant-editable regardless of what's in the request body.
    const {
      id,
      business_id,
      created_at,
      updated_at,
      status,
      source,
      confidence_score,
      imported_at,
      review_required,
      original_import_url,
      original_import_source,
      merchant_verified,
      is_pairley_exclusive,
      offer_image,
      facility_images,
      ...updates
    } = data;

    if (updates.original_price)
      updates.original_price = parseFloat(updates.original_price);
    if (updates.offer_price)
      updates.offer_price = parseFloat(updates.offer_price);
    if (updates.required_people)
      updates.required_people = parseInt(updates.required_people);
    if (updates.start_date) updates.start_date = new Date(updates.start_date);
    if (updates.end_date) updates.end_date = new Date(updates.end_date);
    if (updates.offer_type)
      updates.offer_type = updates.offer_type as OfferType;

    // Version history: snapshot the offer as it was immediately before this edit
    const existingVersionCount = await this.prisma.offerVersion.count({
      where: { offer_id: offerId },
    });
    await this.prisma.offerVersion.create({
      data: {
        offer_id: offerId,
        version_no: existingVersionCount + 1,
        snapshot: offer as any,
        changed_by: businessId,
        change_type: 'MERCHANT_EDIT',
      },
    });

    return this.prisma.offer.update({
      where: { id: offerId },
      data: updates,
    });
  }

  async updateOfferStatus(businessId: string, offerId: string, status: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
    });
    if (!offer) {
      throw new NotFoundException('Offer not found');
    }
    if (offer.business_id !== businessId) {
      throw new ForbiddenException('You do not own this offer');
    }

    const existingVersionCount = await this.prisma.offerVersion.count({
      where: { offer_id: offerId },
    });
    await this.prisma.offerVersion.create({
      data: {
        offer_id: offerId,
        version_no: existingVersionCount + 1,
        snapshot: offer as any,
        changed_by: businessId,
        change_type: 'STATUS_CHANGE',
      },
    });

    return this.prisma.offer.update({
      where: { id: offerId },
      data: { status: status as OfferStatus },
    });
  }

  async uploadOfferMedia(
    businessId: string,
    offerId: string,
    files: {
      cover_image?: Express.Multer.File[];
      gallery?: Express.Multer.File[];
    },
  ) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
    });
    if (!offer) {
      throw new NotFoundException('Offer not found');
    }
    if (offer.business_id !== businessId) {
      throw new ForbiddenException('You do not own this offer');
    }

    // Validate every file in the batch before uploading any — a bad file
    // later in the batch must not leave earlier ones already persisted.
    if (files.cover_image?.[0]) this.validateUpload(files.cover_image[0]);
    for (const file of files.gallery ?? []) this.validateUpload(file);

    const updateData: any = {};

    if (files.cover_image && files.cover_image.length > 0) {
      updateData.cover_image = await this.storageService.uploadFile(
        files.cover_image[0],
        'offers/cover',
      );
    }

    if (files.gallery && files.gallery.length > 0) {
      const uploaded = await Promise.all(
        files.gallery.map((file) =>
          this.storageService.uploadFile(file, 'offers/gallery'),
        ),
      );
      // Append rather than replace, so repeated upload calls accumulate images.
      updateData.gallery_images = [...offer.gallery_images, ...uploaded];
    }

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException('No files provided');
    }

    return this.prisma.offer.update({
      where: { id: offerId },
      data: updateData,
    });
  }

  async removeOfferGalleryImage(
    businessId: string,
    offerId: string,
    url: string,
  ) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
    });
    if (!offer) {
      throw new NotFoundException('Offer not found');
    }
    if (offer.business_id !== businessId) {
      throw new ForbiddenException('You do not own this offer');
    }
    return this.prisma.offer.update({
      where: { id: offerId },
      data: {
        gallery_images: offer.gallery_images.filter((img) => img !== url),
      },
    });
  }

  // "Delete" from the merchant UI archives, never physically deletes — an
  // offer with real customer Lead/OfferInterest history cascades on hard
  // delete (schema still has onDelete: Cascade for those relations), which
  // would permanently destroy that history. Only permanentlyDeleteOffer()
  // (admin-only) actually removes a row.
  async deleteOffer(businessId: string, offerId: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
    });
    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    if (offer.business_id !== businessId) {
      throw new ForbiddenException('You do not own this offer');
    }

    const existingVersionCount = await this.prisma.offerVersion.count({
      where: { offer_id: offerId },
    });
    await this.prisma.offerVersion.create({
      data: {
        offer_id: offerId,
        version_no: existingVersionCount + 1,
        snapshot: offer as any,
        changed_by: businessId,
        change_type: 'ARCHIVED',
      },
    });

    await this.prisma.offer.update({
      where: { id: offerId },
      data: { status: OfferStatus.ARCHIVED },
    });
    return { success: true, message: 'Offer archived successfully' };
  }

  // Admin-only real delete — never exposed to the merchant-facing UI.
  async permanentlyDeleteOffer(offerId: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
    });
    if (!offer) {
      throw new NotFoundException('Offer not found');
    }
    await this.prisma.offer.delete({ where: { id: offerId } });
    return { success: true, message: 'Offer permanently deleted' };
  }

  // Admin-only, dormant — see dashboard.controller.ts's setOfferExclusive.
  async setPairleyExclusive(offerId: string, isExclusive: boolean) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
    });
    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    const existingVersionCount = await this.prisma.offerVersion.count({
      where: { offer_id: offerId },
    });
    await this.prisma.offerVersion.create({
      data: {
        offer_id: offerId,
        version_no: existingVersionCount + 1,
        snapshot: offer as any,
        changed_by: null,
        change_type: 'ADMIN_MODERATION',
      },
    });

    return this.prisma.offer.update({
      where: { id: offerId },
      data: { is_pairley_exclusive: isExclusive },
    });
  }

  async listOffers(filters: {
    category?: string;
    businessId?: string;
    search?: string;
    status?: string;
    mall?: string;
    lat?: number;
    lng?: number;
    radiusKm?: number;
    page?: number;
    limit?: number;
  }) {
    const whereClause: any = {};

    if (filters.category) {
      whereClause.category = filters.category;
    }
    if (filters.businessId) {
      whereClause.business_id = filters.businessId;
    }
    if (filters.status && filters.status !== 'ALL') {
      whereClause.status = filters.status as OfferStatus;
    } else if (!filters.status) {
      whereClause.status = OfferStatus.ACTIVE; // Active by default
      // Defensive expiry filter — belt-and-suspenders alongside the hourly
      // OfferExpiryScheduler sweep, so an offer past its end_date never
      // appears in discovery during the gap before the sweep catches it.
      // Only applied to the default (ACTIVE-only) view, not an explicit
      // status/ALL request, so merchant/admin tooling still sees its own
      // offers regardless of end_date.
      whereClause.end_date = { gte: new Date() };
    }

    // Module 12 Phase 4 — defense in depth: a consolidated (REMOVED)
    // business should never surface in public discovery. Reassignment
    // during consolidation already moves every Offer off the removed
    // business, so this should never actually filter anything out in
    // practice — it's a safety net, not the primary mechanism.
    whereClause.business = { business_status: { not: BusinessStatus.REMOVED } };

    if (filters.mall) {
      whereClause.business.mall_name = filters.mall;
    }

    if (filters.search) {
      whereClause.OR = [
        { title: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    // `status=ALL` (admin/merchant tooling — Deals Moderation, category
    // counts) was the one caller of this method with no row cap at all: it
    // fetched the entire offers table, unpaginated, on every call. At
    // today's catalog size (~20 rows) that's invisible; at the "thousands
    // of offers" volume the launch roadmap targets, an unbounded admin
    // fetch is a real scaling failure waiting to happen. MAX_PAGE_SIZE is a
    // hard ceiling regardless of what a caller requests; DEFAULT_PAGE_SIZE
    // keeps every existing caller's response shape (a plain array) exactly
    // as it was today, just bounded.
    const requestedLimit = filters.limit ?? DEFAULT_LIST_OFFERS_PAGE_SIZE;
    const take = Math.min(
      Math.max(1, requestedLimit),
      MAX_LIST_OFFERS_PAGE_SIZE,
    );
    const page = Math.max(1, filters.page ?? 1);

    const offers = await this.prisma.offer.findMany({
      where: whereClause,
      select: {
        ...PUBLIC_OFFER_FIELDS,
        merchant_verified: true,
        is_pairley_exclusive: true,
        source: true,
        // Module 14 Phase 3A — a browse listing never shows merchant contact
        // to anyone, regardless of who is asking, so this is unconditionally
        // the public projection. Contact is a detail-page decision.
        business: { select: PUBLIC_BUSINESS_SELECT },
      },
      orderBy: { created_at: 'desc' },
      take,
      skip: (page - 1) * take,
    });

    // Geo/radius filtering happens here rather than in the WHERE clause: an
    // offer's effective location is its own geo_lat/geo_lng if set, else
    // the owning business's — a COALESCE-across-relation bounding box isn't
    // expressible via Prisma's query builder without dropping to raw SQL,
    // and at current catalog size a single indexed query (status/category)
    // followed by an in-memory distance pass is simpler and just as
    // correct. The (geo_lat, geo_lng) index exists for when a raw-SQL
    // bounding-box pre-filter becomes worth the added complexity.
    // business.geo_lat/geo_lng and the raw badge-source fields
    // (merchant_verified/is_pairley_exclusive/source) are only fetched to
    // compute derived values below — never part of the public response.
    const finalizeOffer = (o: (typeof offers)[number]) => {
      const { merchant_verified, is_pairley_exclusive, source, ...rest } = o;
      return {
        ...rest,
        badge: computeOfferBadge({
          merchant_verified,
          is_pairley_exclusive,
          source,
        }),
        business: rest.business
          ? { ...rest.business, geo_lat: undefined, geo_lng: undefined }
          : rest.business,
      };
    };

    if (
      filters.lat != null &&
      filters.lng != null &&
      filters.radiusKm != null
    ) {
      const withDistance = offers
        .map((o) => {
          const effLat = o.geo_lat ?? o.business?.geo_lat ?? null;
          const effLng = o.geo_lng ?? o.business?.geo_lng ?? null;
          const distanceKm =
            effLat != null && effLng != null
              ? haversineKm(
                  filters.lat as number,
                  filters.lng as number,
                  effLat,
                  effLng,
                )
              : null;
          return { ...finalizeOffer(o), distanceKm };
        })
        .filter(
          (o) =>
            o.distanceKm != null &&
            o.distanceKm <= (filters.radiusKm as number),
        );

      withDistance.sort(
        (a, b) => (a.distanceKm as number) - (b.distanceKm as number),
      );
      return withDistance;
    }

    return offers.map(finalizeOffer);
  }

  // `requestingUserId` is the caller's own id if authenticated (any role),
  // undefined if anonymous. Only the offer's own business gets other
  // customers' PII (name/mobile/email/address) on the interests list — every
  // other caller (including a logged-in customer checking whether *they*
  // already showed interest) only gets customer_id, which is enough for that
  // self-match check without exposing anyone else's contact details.
  //
  // A non-ACTIVE offer (draft/paused/archived/rejected/etc.) 404s for
  // anyone except the owning business or an admin — everyone else gets the
  // same "not found" a bad id would produce, not a distinguishable
  // "exists but not visible" response.
  async getDetails(
    id: string,
    requestingUserId?: string,
    requestingRole?: string,
  ) {
    const offer = await this.prisma.offer.findUnique({
      where: { id },
      select: {
        ...PUBLIC_OFFER_FIELDS,
        merchant_verified: true,
        is_pairley_exclusive: true,
        source: true,
        // Module 14 Phase 3A — always the public projection on this first
        // query. Whether the caller may see contact details depends on the
        // business's own claim status, which is only known once this has
        // run, so entitled callers get their contact fields in a second,
        // targeted query below. Contact columns therefore never enter the
        // process at all for a caller who isn't entitled to them.
        //
        // business_status also drives the Module 12 Phase 2 "Is this your
        // business? Claim it." prompt (UNCLAIMED only).
        business: { select: PUBLIC_BUSINESS_SELECT },
        interests: {
          select: {
            id: true,
            offer_id: true,
            customer_id: true,
            status: true,
            created_at: true,
          },
        },
      },
    });

    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    const isOwner = requestingUserId && requestingUserId === offer.business_id;
    const isAdmin = requestingRole === 'Admin';

    if (offer.status !== OfferStatus.ACTIVE && !isOwner && !isAdmin) {
      throw new NotFoundException('Offer not found');
    }
    // Module 12 Phase 4 — same defense-in-depth as listOffers(): shouldn't
    // be reachable in practice since consolidation reassigns every Offer
    // off the REMOVED business, but a stale/direct link should still 404
    // for non-admins rather than reveal a removed business's offer.
    if (
      offer.business?.business_status === BusinessStatus.REMOVED &&
      !isAdmin
    ) {
      throw new NotFoundException('Offer not found');
    }

    const { merchant_verified, is_pairley_exclusive, source, ...rest } = offer;

    // Module 13 — the caller's own interest state, so the frontend can
    // render "Show Interest" vs "Interest Already Sent" from this response
    // alone (per requirement: persist across refresh/logout/re-login/device,
    // driven by the backend, not local component state). Only meaningful for
    // a logged-in, non-owner customer; a Lead row exists for every offer
    // type (unlike OfferInterest, which is legacy-matching-types only), so
    // this is populated uniformly regardless of offer_type.
    let myLead: {
      id: string;
      status: string;
      unlocked: boolean;
      created_at: Date;
    } | null = null;
    if (requestingUserId && !isOwner) {
      const lead = await this.prisma.lead.findUnique({
        where: {
          customer_id_offer_id: {
            customer_id: requestingUserId,
            offer_id: id,
          },
        },
      });
      if (lead) {
        myLead = {
          id: lead.id,
          status: lead.status,
          unlocked: !!lead.unlocked_at,
          created_at: lead.created_at,
        };
      }
    }

    // Module 14 Phase 3A / lead-generation revision — merchant contact
    // visibility is configurable platform-wide via LEAD_FOLLOWUP_MODE (see
    // offerVisibility.ts's module docstring). ADMIN_MANAGED (the default)
    // never hands contact to a customer; MERCHANT_MANAGED restores
    // interest-gated direct reveal for CLAIMED businesses. myLead, computed
    // just above, is exactly the "expressed interest" signal
    // MERCHANT_MANAGED mode needs, already scoped to this viewer and offer.
    const leadFollowupMode = resolveLeadFollowupMode(
      this.configService.get<string>('LEAD_FOLLOWUP_MODE'),
    );
    const contactAccess = resolveContactAccess(
      {
        userId: requestingUserId,
        role: requestingRole,
        ownerBusinessId: offer.business_id,
      },
      offer.business,
      !!myLead,
      leadFollowupMode,
    );

    let businessPayload: Record<string, unknown> | null = offer.business
      ? { ...offer.business }
      : null;

    if (contactAccess.canSeeContact && businessPayload) {
      const contact = await this.prisma.business.findUnique({
        where: { id: offer.business_id },
        select: buildBusinessSelect(contactAccess),
      });
      if (contact) businessPayload = { ...businessPayload, ...contact };
    }

    const finalized = {
      ...rest,
      business: decorateBusinessContact(businessPayload, contactAccess),
      badge: computeOfferBadge({
        merchant_verified,
        is_pairley_exclusive,
        source,
      }),
      myLead,
    };

    if (!isOwner) {
      return finalized;
    }

    const interestsWithCustomer = await this.prisma.offerInterest.findMany({
      where: { offer_id: id },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            mobile: true,
            email: true,
            city: true,
            address: true,
          },
        },
      },
    });

    // Module 14 Phase 3A — whatsapp_number left PUBLIC_OFFER_FIELDS (it's a
    // direct merchant contact channel and was previously readable by
    // anonymous callers through both listOffers and the unguarded
    // category route). The owner still needs it on their own offer, so it
    // is fetched here, on the branch that has already established ownership.
    const ownerFields = await this.prisma.offer.findUnique({
      where: { id },
      select: OWNER_ONLY_OFFER_FIELDS,
    });

    return { ...finalized, ...ownerFields, interests: interestsWithCustomer };
  }

  async getOffersByCategory(category: string) {
    return this.listOffers({ category });
  }

  async getCategoryCounts() {
    const grouped = await this.prisma.offer.groupBy({
      by: ['category'],
      where: { status: OfferStatus.ACTIVE, end_date: { gte: new Date() } },
      _count: { category: true },
    });

    const counts: Record<string, number> = {};
    for (const row of grouped) {
      counts[row.category] = row._count.category;
    }
    return counts;
  }

  async expressInterest(customerId: string, offerId: string) {
    // 1. Fetch offer details
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { interests: true },
    });

    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    if (offer.status !== OfferStatus.ACTIVE) {
      throw new BadRequestException('This offer is not active');
    }

    // 2. Check if already joined
    const existing = await this.prisma.offerInterest.findUnique({
      where: {
        offer_id_customer_id: {
          offer_id: offerId,
          customer_id: customerId,
        },
      },
    });

    if (existing) {
      return {
        success: true,
        message: 'Already expressed interest in this offer',
        interest: existing,
      };
    }

    // 3. Create interest
    const interest = await this.prisma.offerInterest.create({
      data: {
        offer_id: offerId,
        customer_id: customerId,
        status: InterestStatus.INTERESTED,
      },
    });

    // 4. Update offer joined_people count based on actual unique record count in DB
    const actualCount = await this.prisma.offerInterest.count({
      where: { offer_id: offerId },
    });

    const updatedOffer = await this.prisma.offer.update({
      where: { id: offerId },
      data: {
        joined_people: actualCount,
      },
      include: {
        interests: {
          include: { customer: true },
        },
        business: true,
      },
    });

    const currentInterest = updatedOffer.interests.find(
      (i) => i.customer_id === customerId,
    );
    const customerName = currentInterest?.customer?.name || 'A customer';
    const customerMobile = currentInterest?.customer?.mobile || '';
    const customerCity = currentInterest?.customer?.city || '';

    // Notify business owner about a partner joining
    await this.notificationService.sendNotification(
      updatedOffer.business_id,
      'Partner Joined Deal',
      `A new customer joined your offer: "${updatedOffer.title}"!\nName: ${customerName}\nContact: ${customerMobile}\nCity: ${customerCity}\nTotal joined: ${updatedOffer.joined_people}`,
      'Partner Joined',
    );

    // Notify other customers in the co-buy match cohort
    const otherInterests = updatedOffer.interests.filter(
      (i) => i.customer_id !== customerId,
    );
    for (const other of otherInterests) {
      await this.notificationService.sendNotification(
        other.customer_id,
        'Co-buyer Joined BOGO Match!',
        `A new partner (${customerName}) joined your BOGO split for "${updatedOffer.title}". Coordination chat is now open!`,
        'PARTNER_JOINED',
      );
    }

    // Send immediate SMS alert to shop owner's notification mobiles (up to 3)
    const interestSmsMsg = `Pairley Interest Alert! Customer ${customerName} (${customerMobile}) from ${customerCity} showed interest in your deal "${updatedOffer.title}".`;
    const notifMobiles = (updatedOffer.business.notification_mobiles || '')
      .split(',')
      .map((num) => num.trim())
      .filter((num) => /^\d{10}$/.test(num));

    if (notifMobiles.length === 0 && updatedOffer.business.mobile) {
      notifMobiles.push(updatedOffer.business.mobile);
    }

    for (const contact of notifMobiles.slice(0, 3)) {
      try {
        await this.otpService.sendSms(contact, interestSmsMsg);
      } catch (smsErr) {
        console.error(`Failed to send interest SMS to ${contact}:`, smsErr);
      }
    }

    // 5. Check if required target is reached
    if (updatedOffer.joined_people >= updatedOffer.required_people) {
      // Transition all interests for this offer to READY_TO_BUY
      await this.prisma.offerInterest.updateMany({
        where: { offer_id: offerId, status: InterestStatus.INTERESTED },
        data: { status: InterestStatus.READY_TO_BUY },
      });

      // Update offer status to CLOSED (meaning capacity reached)
      await this.prisma.offer.update({
        where: { id: offerId },
        data: { status: OfferStatus.CLOSED },
      });

      // Notify business owner (in-app/push)
      await this.notificationService.sendNotification(
        updatedOffer.business_id,
        'Offer Target Achieved!',
        `Your offer "${updatedOffer.title}" has reached the required participation of ${updatedOffer.required_people} people. You can now contact the ready buyers.`,
        'Offer Completed',
      );

      // Notify all customers who joined (in-app/push + SMS)
      const customerSmsMsg = `Pairley Match! Your deal for "${updatedOffer.title}" is completed. The business will contact you soon.`;
      for (const i of updatedOffer.interests) {
        try {
          await this.notificationService.sendNotification(
            i.customer_id,
            'Group Deal Completed!',
            `The deal for "${updatedOffer.title}" is ready! The business will contact you soon.`,
            'Offer Completed',
          );
        } catch (notifErr) {
          console.error(
            `Failed to send match completion in-app notification to customer ${i.customer_id}:`,
            notifErr,
          );
        }
        if (i.customer.mobile) {
          try {
            await this.otpService.sendSms(i.customer.mobile, customerSmsMsg);
          } catch (smsErr) {
            console.error(
              `Failed to send match completion SMS to customer ${i.customer.mobile}:`,
              smsErr,
            );
          }
        }
      }

      // Dispatch details to merchant notification mobile numbers
      const merchantContacts = (
        updatedOffer.business.notification_mobiles || ''
      )
        .split(',')
        .map((num) => num.trim())
        .filter((num) => /^\d{10}$/.test(num));

      // Fallback to primary business number if no custom contacts saved
      if (merchantContacts.length === 0 && updatedOffer.business.mobile) {
        merchantContacts.push(updatedOffer.business.mobile);
      }

      if (merchantContacts.length > 0) {
        const buyersList = updatedOffer.interests
          .map(
            (i, index) =>
              `${index + 1}. ${i.customer.name} (${i.customer.mobile})`,
          )
          .join(', ');
        const merchantSmsMsg = `Pairley Match Alert! Offer '${updatedOffer.title}' has matched. Buyers: ${buyersList}.`;

        for (const contact of merchantContacts.slice(0, 3)) {
          // Limit to up to 3 numbers
          try {
            await this.otpService.sendSms(contact, merchantSmsMsg);
          } catch (smsErr) {
            console.error(
              `Failed to send match completion SMS to merchant ${contact}:`,
              smsErr,
            );
          }
        }
      }
    }

    return {
      success: true,
      message: 'Expressed interest successfully',
      interest,
    };
  }

  async declareReadyToBuy(customerId: string, offerId: string) {
    const interest = await this.prisma.offerInterest.findUnique({
      where: {
        offer_id_customer_id: {
          offer_id: offerId,
          customer_id: customerId,
        },
      },
    });

    if (!interest) {
      throw new NotFoundException(
        'You have not expressed interest in this offer yet',
      );
    }

    const updatedInterest = await this.prisma.offerInterest.update({
      where: { id: interest.id },
      data: { status: InterestStatus.READY_TO_BUY },
    });

    return {
      success: true,
      message: 'Ready to buy status set successfully',
      interest: updatedInterest,
    };
  }

  async getInterestedCustomers(businessId: string) {
    // Fetch all offers owned by this business, and list their interest lists
    return this.prisma.offer.findMany({
      where: { business_id: businessId },
      include: {
        interests: {
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                mobile: true,
                email: true,
                city: true,
                address: true,
              },
            },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async updateInterestStatus(
    businessId: string,
    interestId: string,
    status: string,
  ) {
    const interest = await this.prisma.offerInterest.findUnique({
      where: { id: interestId },
      include: { offer: true },
    });

    if (!interest) {
      throw new NotFoundException('Interest record not found');
    }

    if (interest.offer.business_id !== businessId) {
      throw new ForbiddenException(
        'You do not own the offer associated with this interest',
      );
    }

    const updated = await this.prisma.offerInterest.update({
      where: { id: interestId },
      data: { status: status as any },
    });

    return { success: true, interest: updated };
  }

  async sendCoBuyMessage(customerId: string, dealId: string, data: any) {
    const interest = await this.prisma.offerInterest.findUnique({
      where: {
        offer_id_customer_id: {
          offer_id: dealId,
          customer_id: customerId,
        },
      },
    });

    if (!interest) {
      throw new BadRequestException(
        'You must show interest in this deal to send messages.',
      );
    }

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });
    const senderName = customer?.name || 'Anonymous Buyer';

    const msg = await this.prisma.coBuyMessage.create({
      data: {
        deal_id: dealId,
        sender_id: customerId,
        sender_name: senderName,
        text: data.text,
        is_schedule_card: data.is_schedule_card ?? false,
        day: data.day || null,
        time_slot: data.time_slot || null,
        is_system: data.is_system ?? false,
      },
    });

    return msg;
  }

  async getCoBuyMessages(dealId: string, callerId: string, callerRole: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: dealId },
      select: { business_id: true },
    });
    if (!offer) {
      throw new NotFoundException('Deal not found');
    }

    const isOwner = callerRole === 'Business' && offer.business_id === callerId;
    if (!isOwner) {
      const interest = await this.prisma.offerInterest.findUnique({
        where: {
          offer_id_customer_id: {
            offer_id: dealId,
            customer_id: callerId,
          },
        },
      });
      if (!interest) {
        throw new ForbiddenException(
          'You must show interest in this deal to view messages.',
        );
      }
    }

    return this.prisma.coBuyMessage.findMany({
      where: { deal_id: dealId },
      orderBy: { created_at: 'asc' },
    });
  }

  async createLead(
    customerId: string,
    offerId: string,
    source: LeadSource = LeadSource.WEBSITE,
  ) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { business: true },
    });

    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    // Module 13 — hard, permanent duplicate block (replaces the old 24-hour
    // soft window: a customer could previously re-trigger a fresh Lead +
    // WhatsApp alert for the same offer once a day). Backed by Lead's new
    // @@unique([customer_id, offer_id]) — this pre-check exists to return a
    // clean 400 with the existing lead attached rather than surfacing a raw
    // Prisma P2002 constraint-violation error to the client.
    const existingLead = await this.prisma.lead.findUnique({
      where: {
        customer_id_offer_id: {
          customer_id: customerId,
          offer_id: offerId,
        },
      },
    });

    if (existingLead) {
      throw new BadRequestException({
        message: 'You have already expressed interest in this deal.',
        lead: existingLead,
      });
    }

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });

    if (!customer) {
      throw new NotFoundException('Customer profile not found');
    }

    const lead = await this.prisma.lead.create({
      data: {
        customer_id: customerId,
        customer_name: customer.name,
        customer_mobile: customer.mobile,
        offer_id: offerId,
        offer_name: offer.title,
        shop_id: offer.business_id,
        shop_name: offer.business.business_name,
        status: LeadStatus.NEW,
        source,
      },
    });

    // Module 13 — merchant notification channel priority, in order:
    //   1. In-app notification (below) — unconditional, the primary and
    //      authoritative signal. This is what "the merchant should always
    //      manage leads from within Pairley" means in code: nothing here is
    //      gated by a setting or an external service being configured.
    //   2. Push — bundled inside sendNotification() itself (looks up the
    //      business's PushToken rows and sends via FCM if any exist), not a
    //      separate call.
    //   3. Email — not yet built. Reserved as the next channel to add
    //      before WhatsApp in this priority order, should a merchant want a
    //      channel that doesn't require the app open.
    //   4. WhatsApp (sendLeadWhatsappAlert, below) — optional and merchant-
    //      configurable (business.notify_whatsapp), lowest priority, purely
    //      additive. It was previously the *only* signal a merchant got
    //      (via the customer's own browser opening wa.me popups, which
    //      silently did nothing if the tab closed or the popup was
    //      blocked) — it is now one optional channel among several, never
    //      the sole or primary one, and never required for the merchant to
    //      see or act on a lead.
    // Both calls are fire-and-forget: neither blocks or fails the
    // customer's Show Interest action.
    this.notificationService
      .sendNotification(
        offer.business_id,
        'New Lead!',
        `${customer.name} showed interest in "${offer.title}". Tap to view.`,
        'NEW_LEAD',
      )
      .catch((err) => {});

    this.sendLeadWhatsappAlert(offer.business, customer, offer, lead.id).catch(
      () => {},
    );

    // Legacy pair/group matching mechanics only: also register the customer
    // in the OfferInterest matching pool (capacity tracking, chat, auto-close
    // on capacity reached — all handled elsewhere via expressInterest()'s
    // continuation of this same mechanic). STANDARD and the new mechanics
    // stop here — Lead alone is the whole "Show Interest" outcome, matching
    // the simplified Customer -> Show Interest -> Lead -> Merchant Dashboard
    // flow. No chat, no matching, no waiting.
    if (LEGACY_MATCHING_OFFER_TYPES.has(offer.offer_type)) {
      const existingInterest = await this.prisma.offerInterest.findUnique({
        where: {
          offer_id_customer_id: {
            offer_id: offerId,
            customer_id: customerId,
          },
        },
      });

      if (!existingInterest) {
        await this.prisma.offerInterest.create({
          data: {
            offer_id: offerId,
            customer_id: customerId,
            status: InterestStatus.INTERESTED,
          },
        });

        // Update offer joined_people count based on actual unique record count in DB
        const actualCount = await this.prisma.offerInterest.count({
          where: { offer_id: offerId },
        });

        await this.prisma.offer.update({
          where: { id: offerId },
          data: {
            joined_people: actualCount,
          },
        });
      }
    }

    // Module 13 — the frontend no longer opens a customer-side wa.me deep
    // link on Show Interest (that was the "automatic WhatsApp redirect"
    // being removed), so it has no use for target merchant phone numbers
    // any more. The merchant-facing WhatsApp Business API alert above
    // (sendLeadWhatsappAlert) is unaffected — that's a server-side,
    // merchant-opt-in channel (business.notify_whatsapp), not the customer
    // interaction path this module removes.
    return {
      success: true,
      lead,
      offerName: offer.title,
      shopName: offer.business.business_name,
    };
  }

  // Module 8, re-scoped by Module 13 to the lowest-priority optional
  // channel (see the priority comment in createLead above) — WhatsApp
  // Business API lead alert to the merchant's verified number. Requires an
  // approved template (business-initiated messages outside a 24h session
  // window can't use freeform text) — fails gracefully and gets logged as
  // FAILED until "new_lead_alert" is submitted/approved in Meta Business
  // Manager; this is expected, not a bug, until that external step is
  // done, and the merchant is never blocked on it since the in-app
  // notification + Leads page are unconditional. One retry on failure, no
  // queue — see Module 8 STEP 1's approved retry-strategy decision.
  private async sendLeadWhatsappAlert(
    business: {
      id: string;
      mobile: string | null;
      lead_whatsapp_number: string | null;
      lead_whatsapp_verified: boolean;
      notify_whatsapp: boolean;
    },
    customer: { name: string },
    offer: { title: string },
    leadId: string,
  ): Promise<void> {
    if (!business.notify_whatsapp) {
      return;
    }
    const { number, verified } = resolveLeadWhatsappNumber(business);
    if (!verified || !number) {
      return;
    }
    const phoneNumberId = this.whatsappService.getSenderPhoneNumberId();
    if (!phoneNumberId) {
      return;
    }

    const components = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: customer.name },
          { type: 'text', text: offer.title },
        ],
      },
    ];

    let result = await this.whatsappService.sendTemplateMessage(
      number,
      phoneNumberId,
      'new_lead_alert',
      'en',
      components,
    );
    if (!result.success) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      result = await this.whatsappService.sendTemplateMessage(
        number,
        phoneNumberId,
        'new_lead_alert',
        'en',
        components,
      );
    }

    await this.prisma.whatsAppMessage.create({
      data: {
        business_id: business.id,
        direction: 'OUTBOUND',
        template: 'new_lead_alert',
        to_number: number,
        status: result.success ? 'SENT' : 'FAILED',
        error: result.error,
        related_lead_id: leadId,
      },
    });
  }

  // System sweep (see OfferExpiryScheduler) — flips ACTIVE/PAUSED offers
  // whose end_date has passed to EXPIRED. Runs unattended, so changed_by
  // is left null on the version snapshot.
  async expireOffers() {
    const now = new Date();
    const expiring = await this.prisma.offer.findMany({
      where: {
        status: { in: [OfferStatus.ACTIVE, OfferStatus.PAUSED] },
        end_date: { lt: now },
      },
    });

    for (const offer of expiring) {
      const existingVersionCount = await this.prisma.offerVersion.count({
        where: { offer_id: offer.id },
      });
      await this.prisma.offerVersion.create({
        data: {
          offer_id: offer.id,
          version_no: existingVersionCount + 1,
          snapshot: offer as any,
          changed_by: null,
          change_type: 'SYSTEM_EXPIRED',
        },
      });
    }

    if (expiring.length > 0) {
      await this.prisma.offer.updateMany({
        where: { id: { in: expiring.map((o) => o.id) } },
        data: { status: OfferStatus.EXPIRED },
      });
    }

    return { success: true, expiredCount: expiring.length };
  }
}
