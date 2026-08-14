import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OfferStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { FileValidationService } from '../discovery/file-validation.service';
import { OfferDraftCreationService } from '../offer/offer-draft-creation.service';
import { extractZipEntries } from '../common/utils/extract-zip-entries';
import { CategoryService } from '../common/taxonomy/category.service';

const COVER_FOLDER = 'offer-publisher/covers';
const GALLERY_FOLDER = 'offer-publisher/gallery';
const MAX_ZIP_SIZE_BYTES = 250 * 1024 * 1024;

export interface UpdateDraftFields {
  merchantName?: string;
  mobile?: string;
  whatsapp?: string;
  email?: string;
  city?: string;
  area?: string;
  address?: string;
  state?: string;
  pincode?: string;
  googleMapsLink?: string;
  category?: string;
  title?: string;
  description?: string;
  originalPrice?: number;
  offerPrice?: number;
  minParticipants?: number;
  startDate?: string;
  endDate?: string;
  terms?: string;
}

interface StagedImage {
  fileName: string;
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/**
 * Backs the Offer Publisher admin flow: Upload Images -> one Draft offer
 * per image -> fill in details -> Approve -> Publish. Every operation here
 * is a single synchronous request/response — no batch entity, no scheduler
 * — because uploading one image and creating one offer is not the kind of
 * multi-stage, thousands-of-rows work bulk-import's scheduler exists for.
 */
@Injectable()
export class OfferPublisherService {
  private readonly logger = new Logger(OfferPublisherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly fileValidation: FileValidationService,
    private readonly draftCreation: OfferDraftCreationService,
    private readonly categoryService: CategoryService,
  ) {}

  // ---------------------------------------------------------------------
  // Step 1 — image upload, one placeholder draft per accepted image.
  // ---------------------------------------------------------------------

  private async createOneDraft(image: StagedImage) {
    try {
      this.fileValidation.validate(image);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid image file';
      return { ok: false as const, fileName: image.fileName, error: message };
    }

    try {
      const url = await this.storage.uploadFile(
        {
          originalname: this.fileValidation.sanitizeFilename(image.fileName),
          buffer: image.buffer,
          mimetype: image.mimetype,
        } as Express.Multer.File,
        COVER_FOLDER,
      );
      const { businessId, offerId } =
        await this.draftCreation.createPlaceholderDraft(url);
      return {
        ok: true as const,
        fileName: image.fileName,
        offerId,
        businessId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      this.logger.error(
        `Offer Publisher: failed to create draft for ${image.fileName}: ${message}`,
      );
      return { ok: false as const, fileName: image.fileName, error: message };
    }
  }

  async createDraftsFromFiles(files: Express.Multer.File[]) {
    const results = await Promise.all(
      files.map((f) =>
        this.createOneDraft({
          fileName: f.originalname,
          buffer: f.buffer,
          mimetype: f.mimetype,
          size: f.size,
        }),
      ),
    );
    return this.summarize(results);
  }

  async createDraftsFromZip(zipFile: Express.Multer.File) {
    if (zipFile.size > MAX_ZIP_SIZE_BYTES) {
      throw new BadRequestException(
        `ZIP exceeds the maximum allowed size of ${MAX_ZIP_SIZE_BYTES / (1024 * 1024)}MB`,
      );
    }
    const entries = await extractZipEntries(zipFile.buffer);
    const results = await Promise.all(
      entries.map((e) =>
        this.createOneDraft({
          fileName: e.fileName,
          buffer: e.buffer,
          mimetype: e.mimetype,
          size: e.buffer.length,
        }),
      ),
    );
    return this.summarize(results);
  }

  private summarize(
    results: Array<
      | { ok: true; fileName: string; offerId: string; businessId: string }
      | { ok: false; fileName: string; error: string }
    >,
  ) {
    return {
      drafts: results
        .filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
        .map((r) => ({
          offerId: r.offerId,
          businessId: r.businessId,
          fileName: r.fileName,
        })),
      failed: results
        .filter((r): r is Extract<typeof r, { ok: false }> => !r.ok)
        .map((r) => ({ fileName: r.fileName, error: r.error })),
    };
  }

  // ---------------------------------------------------------------------
  // Step 2 — read/edit a draft.
  // ---------------------------------------------------------------------

  private async loadOfferWithBusiness(offerId: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { business: true },
    });
    if (!offer) throw new NotFoundException('Draft offer not found');
    return offer;
  }

  private toDetail(
    offer: Awaited<ReturnType<typeof this.loadOfferWithBusiness>>,
  ) {
    return {
      id: offer.id,
      offerCode: offer.offer_code,
      status: offer.status,
      title: offer.title,
      description: offer.description,
      category: offer.category,
      originalPrice: offer.original_price,
      offerPrice: offer.offer_price,
      minParticipants: offer.required_people,
      startDate: offer.start_date,
      endDate: offer.end_date,
      terms: offer.terms,
      rejectionReason: offer.rejection_reason,
      coverImage: offer.cover_image,
      galleryImages: offer.gallery_images,
      merchant: {
        businessId: offer.business_id,
        merchantName: offer.business.business_name,
        mobile: offer.business.mobile,
        whatsapp: offer.whatsapp_number,
        email: offer.business.email,
        city: offer.business.city,
        area: offer.business.area,
        address: offer.business.address,
        state: offer.business.state,
        pincode: offer.business.pincode,
        googleMapsLink: offer.business.google_maps_link,
      },
    };
  }

  async listDrafts(ids: string[]) {
    if (ids.length === 0) return [];
    const offers = await this.prisma.offer.findMany({
      where: { id: { in: ids } },
      include: { business: true },
    });
    return offers.map((o) => this.toDetail(o));
  }

  async getDraft(offerId: string) {
    return this.toDetail(await this.loadOfferWithBusiness(offerId));
  }

  /**
   * Editing an APPROVED draft reverts it to DRAFT — an admin who already
   * clicked Approve, then changes the price, must re-review before it can
   * publish again. Applies to APPROVED and REJECTED alike (a corrected
   * rejected draft goes back to DRAFT, not straight to APPROVED).
   */
  async updateDraft(offerId: string, fields: UpdateDraftFields) {
    const offer = await this.loadOfferWithBusiness(offerId);
    if (
      offer.status !== OfferStatus.DRAFT &&
      offer.status !== OfferStatus.APPROVED &&
      offer.status !== OfferStatus.REJECTED
    ) {
      throw new BadRequestException(
        `Cannot edit an offer that is already ${offer.status}`,
      );
    }

    const wasApprovedOrRejected = offer.status !== OfferStatus.DRAFT;
    const oldBusinessId = offer.business_id;
    let businessId = offer.business_id;
    const mobile = fields.mobile?.trim();
    const rePointing = Boolean(mobile && mobile !== offer.business.mobile);

    // Resolved once, up front, so the offer and its business can never end
    // up on different spellings of the same category. Throws before the
    // transaction opens if the value is unrecognised. `undefined` means
    // "field not supplied" and leaves the existing value untouched.
    const category =
      fields.category === undefined
        ? undefined
        : this.categoryService.normalizeForStorage(fields.category);

    // `Offer.business` is onDelete: Cascade — deleting a business cascades
    // to every offer still pointing at it. The re-point (offer.update to
    // the new business_id) and the old-business orphan cleanup are
    // therefore strictly ordered and run in one transaction: cleaning up
    // the old business before the offer stops referencing it would cascade
    // and destroy the very offer this call is trying to save.
    const updated = await this.prisma.$transaction(async (tx) => {
      if (rePointing) {
        const match = await this.draftCreation.matchOrCreateBusiness(
          {
            merchantName: fields.merchantName || offer.business.business_name,
            mobile,
            email: fields.email,
            category,
            address: fields.address,
            city: fields.city,
            state: fields.state,
            pincode: fields.pincode,
            area: fields.area,
            googleMapsLink: fields.googleMapsLink,
          },
          tx,
        );
        businessId = match.businessId;
      } else {
        await tx.business.update({
          where: { id: businessId },
          data: {
            business_name: fields.merchantName ?? offer.business.business_name,
            owner_name: fields.merchantName ?? offer.business.owner_name,
            // Business.email is @unique. The admin form always submits
            // `email: ""` when the field is left blank (never omitted), so
            // `?? offer.business.email` wrote the literal empty string —
            // fine for the first draft ever saved with a blank email, and a
            // P2002 unique-constraint crash (surfacing as a raw 500) for
            // every one after it, since Postgres treats '' as a real,
            // colliding value unlike NULL. Normalise blank to null, exactly
            // matching matchOrCreateBusiness's already-correct handling of
            // the same field on the sibling (re-point) branch below.
            email:
              fields.email === undefined
                ? offer.business.email
                : fields.email.trim() || null,
            city: fields.city ?? offer.business.city,
            area: fields.area ?? offer.business.area,
            address: fields.address ?? offer.business.address,
            state: fields.state ?? offer.business.state,
            pincode: fields.pincode ?? offer.business.pincode,
            category: category ?? offer.business.category,
            google_maps_link:
              fields.googleMapsLink ?? offer.business.google_maps_link,
          },
        });
      }

      const savedOffer = await tx.offer.update({
        where: { id: offerId },
        data: {
          business_id: businessId,
          title: fields.title ?? offer.title,
          description: fields.description ?? offer.description,
          category: category ?? offer.category,
          original_price: fields.originalPrice ?? offer.original_price,
          offer_price: fields.offerPrice ?? offer.offer_price,
          required_people: fields.minParticipants ?? offer.required_people,
          start_date: fields.startDate
            ? new Date(fields.startDate)
            : offer.start_date,
          end_date: fields.endDate ? new Date(fields.endDate) : offer.end_date,
          whatsapp_number: fields.whatsapp ?? offer.whatsapp_number,
          terms: fields.terms ?? offer.terms,
          status: wasApprovedOrRejected ? OfferStatus.DRAFT : offer.status,
          rejection_reason: wasApprovedOrRejected
            ? null
            : offer.rejection_reason,
        },
        include: { business: true },
      });

      // Orphan cleanup — only now that this offer no longer references it.
      // Removes the placeholder business if it has zero remaining offers,
      // so a search (§ searchBusinesses) doesn't surface an empty
      // "Untitled Merchant".
      if (rePointing && businessId !== oldBusinessId) {
        const remaining = await tx.offer.count({
          where: { business_id: oldBusinessId },
        });
        if (remaining === 0) {
          await tx.business.delete({ where: { id: oldBusinessId } });
        }
      }

      return savedOffer;
    });

    return this.toDetail(updated);
  }

  async addGalleryImage(offerId: string, files: Express.Multer.File[]) {
    const offer = await this.loadOfferWithBusiness(offerId);
    for (const file of files) {
      this.fileValidation.validate(file);
    }
    const uploaded = await Promise.all(
      files.map((f) => this.storage.uploadFile(f, GALLERY_FOLDER)),
    );
    const updated = await this.prisma.offer.update({
      where: { id: offerId },
      data: { gallery_images: [...offer.gallery_images, ...uploaded] },
      include: { business: true },
    });
    return this.toDetail(updated);
  }

  async removeGalleryImage(offerId: string, url: string) {
    const offer = await this.loadOfferWithBusiness(offerId);
    const updated = await this.prisma.offer.update({
      where: { id: offerId },
      data: {
        gallery_images: offer.gallery_images.filter((img) => img !== url),
      },
      include: { business: true },
    });
    // Best-effort — deleteFile() never throws, so this never blocks the
    // response even if the physical delete fails.
    await this.storage.deleteFile(url);
    return this.toDetail(updated);
  }

  async deleteDraft(offerId: string) {
    const offer = await this.loadOfferWithBusiness(offerId);
    if (
      offer.status !== OfferStatus.DRAFT &&
      offer.status !== OfferStatus.REJECTED
    ) {
      throw new BadRequestException(
        `Cannot delete an offer that is ${offer.status} — only DRAFT or REJECTED drafts can be removed`,
      );
    }

    await this.storage.deleteFile(offer.cover_image || '');
    await Promise.all(
      offer.gallery_images.map((url) => this.storage.deleteFile(url)),
    );

    await this.prisma.offer.delete({ where: { id: offerId } });

    const remaining = await this.prisma.offer.count({
      where: { business_id: offer.business_id },
    });
    if (remaining === 0) {
      await this.prisma.business.delete({ where: { id: offer.business_id } });
    }
  }

  // ---------------------------------------------------------------------
  // Steps 3-4 — approve / reject / publish.
  // ---------------------------------------------------------------------

  /**
   * allowMissingPrice (2026-08-14): the AI Offers From Online pipeline
   * publishes real offers with no numeric price (BOGO/percentage/couple/
   * group offers are all valid without one — offer_price is 0, a sentinel,
   * never a real ₹0). Offer Publisher's own manual flow — a human directly
   * creating a standard priced offer — still requires a real price, exactly
   * as before; only AiOffersFromOnlineService.publish() passes true here.
   */
  async approveDraft(offerId: string, allowMissingPrice = false) {
    const offer = await this.loadOfferWithBusiness(offerId);
    if (offer.status !== OfferStatus.DRAFT) {
      throw new BadRequestException(
        `Only a DRAFT offer can be approved (currently ${offer.status})`,
      );
    }

    const missing: string[] = [];
    if (!offer.title || offer.title === 'Untitled offer') missing.push('title');
    if (!offer.description) missing.push('description');
    if (!offer.category) missing.push('category');
    // originalPrice deliberately not required — BOGO/BOGT-style offers
    // ("Buy 2 Get 1 Free") have no meaningful original price, only the
    // promotional structure itself.
    if (!allowMissingPrice && !offer.offer_price) missing.push('offerPrice');
    if (!offer.required_people || offer.required_people < 1)
      missing.push('minParticipants');
    if (!offer.business.mobile) missing.push('merchant mobile');
    if (!offer.business.city) missing.push('city');
    if (!offer.business.address) missing.push('address');
    if (!offer.cover_image) missing.push('cover image');
    if (missing.length > 0) {
      throw new BadRequestException(
        `Cannot approve — missing: ${missing.join(', ')}`,
      );
    }

    const updated = await this.prisma.offer.update({
      where: { id: offerId },
      data: { status: OfferStatus.APPROVED },
      include: { business: true },
    });
    return this.toDetail(updated);
  }

  async rejectDraft(offerId: string, reason?: string) {
    const offer = await this.loadOfferWithBusiness(offerId);
    if (
      offer.status !== OfferStatus.DRAFT &&
      offer.status !== OfferStatus.APPROVED
    ) {
      throw new BadRequestException(
        `Cannot reject an offer that is ${offer.status}`,
      );
    }
    const updated = await this.prisma.offer.update({
      where: { id: offerId },
      data: { status: OfferStatus.REJECTED, rejection_reason: reason || null },
      include: { business: true },
    });
    return this.toDetail(updated);
  }

  async publishDraft(offerId: string) {
    const offer = await this.loadOfferWithBusiness(offerId);
    if (offer.status !== OfferStatus.APPROVED) {
      throw new BadRequestException(
        `Only Approved offers can be published (currently ${offer.status})`,
      );
    }
    const updated = await this.prisma.offer.update({
      where: { id: offerId },
      data: { status: OfferStatus.ACTIVE },
      include: { business: true },
    });
    return this.toDetail(updated);
  }

  async searchBusinesses(q: string) {
    if (!q || q.trim().length < 2) return [];
    return this.prisma.business.findMany({
      where: {
        OR: [
          { business_name: { contains: q, mode: 'insensitive' } },
          { mobile: { contains: q } },
        ],
      },
      select: {
        id: true,
        business_name: true,
        mobile: true,
        city: true,
        business_status: true,
      },
      take: 10,
    });
  }
}
