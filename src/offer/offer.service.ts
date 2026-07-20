import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../common/services/notification.service';
import { OtpService } from '../common/services/otp.service';
import { StorageService } from '../common/services/storage.service';
import {
  OfferType,
  OfferStatus,
  InterestStatus,
  SubscriptionStatus,
  VerificationStatus,
  LeadStatus,
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

// Offer scalar fields safe to return from the public/customer-facing read
// paths (listOffers, getDetails — both unauthenticated endpoints). Excludes
// `source` and every Pairley 2.0 provenance field (confidence_score,
// imported_at, review_required, original_import_url, original_import_source,
// merchant_verified, is_pairley_exclusive, original_poster,
// generated_offer_card) — customers must never see whether/how an offer was
// imported, only the computed `badge` field added onto each response below.
const PUBLIC_OFFER_FIELDS = {
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
  whatsapp_number: true,
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

@Injectable()
export class OfferService {
  constructor(
    private prisma: PrismaService,
    private notificationService: NotificationService,
    private otpService: OtpService,
    private storageService: StorageService,
  ) {}

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
        category: data.category,
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

    if (filters.mall) {
      whereClause.business = {
        mall_name: filters.mall,
      };
    }

    if (filters.search) {
      whereClause.OR = [
        { title: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const offers = await this.prisma.offer.findMany({
      where: whereClause,
      select: {
        ...PUBLIC_OFFER_FIELDS,
        merchant_verified: true,
        is_pairley_exclusive: true,
        source: true,
        business: {
          select: {
            business_name: true,
            city: true,
            shop_photo: true,
            mall_name: true,
            geo_lat: true,
            geo_lng: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
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
        business: {
          select: {
            id: true,
            business_name: true,
            owner_name: true,
            mobile: true,
            email: true,
            address: true,
            city: true,
            state: true,
            shop_photo: true,
          },
        },
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

    const { merchant_verified, is_pairley_exclusive, source, ...rest } = offer;
    const finalized = {
      ...rest,
      badge: computeOfferBadge({
        merchant_verified,
        is_pairley_exclusive,
        source,
      }),
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

    return { ...finalized, interests: interestsWithCustomer };
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

  async getCoBuyMessages(dealId: string) {
    return this.prisma.coBuyMessage.findMany({
      where: { deal_id: dealId },
      orderBy: { created_at: 'asc' },
    });
  }

  async createLead(customerId: string, offerId: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { business: true },
    });

    if (!offer) {
      throw new NotFoundException('Offer not found');
    }

    // 24-hour duplicate check
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existingLead = await this.prisma.lead.findFirst({
      where: {
        customer_id: customerId,
        offer_id: offerId,
        created_at: {
          gte: twentyFourHoursAgo,
        },
      },
    });

    if (existingLead) {
      throw new BadRequestException(
        'You have already expressed interest in this deal.',
      );
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
      },
    });

    // Notify the merchant server-side (DB row + push if a token exists) —
    // previously the only signal a merchant got was the customer's own
    // browser opening wa.me popups, which silently do nothing if the tab
    // closes or the browser blocks them. Fire-and-forget: never blocks or
    // fails the customer's Show Interest action.
    this.notificationService
      .sendNotification(
        offer.business_id,
        'New Lead!',
        `${customer.name} showed interest in "${offer.title}". Tap to view.`,
        'NEW_LEAD',
      )
      .catch((err) => {});

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

    // Collate target numbers: offer's whatsapp_number, business notification_mobiles, and business mobile
    const mobiles: string[] = [];
    if (offer.whatsapp_number) {
      mobiles.push(offer.whatsapp_number);
    }
    if (offer.business.notification_mobiles) {
      const notifs = offer.business.notification_mobiles
        .split(',')
        .map((num) => num.trim())
        .filter((num) => /^\d{10}$/.test(num));
      mobiles.push(...notifs);
    }
    if (mobiles.length === 0 && offer.business.mobile) {
      mobiles.push(offer.business.mobile);
    }

    // Unique target mobiles (up to 3)
    const uniqueMobiles = [...new Set(mobiles)].slice(0, 3);

    return {
      success: true,
      lead,
      targetMobiles: uniqueMobiles,
      offerName: offer.title,
      shopName: offer.business.business_name,
      customerName: customer.name,
      customerMobile: customer.mobile,
    };
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
