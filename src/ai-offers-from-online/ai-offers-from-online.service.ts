import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AiOfferFromOnlineStatus, OfferStatus, OfferType, Source } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { OfferDraftCreationService } from '../offer/offer-draft-creation.service';
import { OfferPublisherService } from '../offer-publisher/offer-publisher.service';
import { CategoryService } from '../common/taxonomy/category.service';

const BANNER_FOLDER = 'ai-offers-from-online/banners';

export interface ExportedOfferFields {
  collectorOfferId: string;
  merchantName: string;
  mobile?: string;
  whatsapp?: string;
  category?: string;
  address: string;
  city?: string;
  offerTitle: string;
  description?: string;
  originalPrice?: number;
  offerPrice?: number;
  validityStart?: string;
  validityEnd?: string;
  terms?: string;
  sourceUrl?: string;
  sourceType?: string;
  fieldProvenance?: Record<string, string>;
}

export interface CorrectOfferFields {
  merchantName?: string;
  mobile?: string;
  whatsapp?: string;
  category?: string;
  address?: string;
  city?: string;
  offerTitle?: string;
  description?: string;
  originalPrice?: number;
  offerPrice?: number;
  terms?: string;
}

/** The outcome of one offer inside a bulk Publish Selected run. */
export type BulkPublishOutcome = 'PUBLISHED' | 'NEEDS_MERCHANT' | 'FAILED';

export interface BulkPublishItemResult {
  id: string;
  outcome: BulkPublishOutcome;
  offerId: string | null;
  error: string | null;
}

export interface BulkPublishResult {
  published: number;
  needsMerchant: number;
  failed: number;
  results: BulkPublishItemResult[];
}

/** Terminal states — a re-export from the Collector must never silently resurrect one of these. */
const TERMINAL_STATUSES: AiOfferFromOnlineStatus[] = [
  AiOfferFromOnlineStatus.PUBLISHED,
  AiOfferFromOnlineStatus.REJECTED,
];

/**
 * "AI Offers From Online" — the intake queue for the standalone AI Offer
 * Collector.
 *
 * Ownership split: the Collector owns the creative (extraction, price and
 * address resolution, banner generation, and the human banner approval).
 * This queue owns the publishing decision only. An offer arrives here
 * complete — approved banner and resolved price both guaranteed by the
 * Collector's export gate — so there is no enrichment loop, no callback
 * into the Collector, and no banner regeneration on this side. The exact
 * approved banner bytes are the canonical artifact.
 *
 * Creating a queue row never touches Business/Offer. Only publish() does
 * that, and only after a human has explicitly matched an existing business
 * or created a new one.
 */
@Injectable()
export class AiOffersFromOnlineService {
  private readonly logger = new Logger(AiOffersFromOnlineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly draftCreation: OfferDraftCreationService,
    private readonly offerPublisherService: OfferPublisherService,
    private readonly categoryService: CategoryService,
  ) {}

  // ---------------------------------------------------------------------
  // Export intake (from the Collector) — upsert by collector_offer_id.
  // ---------------------------------------------------------------------

  /**
   * Accepts one fully-ready offer exported from the Collector. Both the
   * approved banner and a resolved offer price are REQUIRED: the Collector
   * cannot generate a banner without a price, nor export without an
   * approved banner, so an export missing either is a contract violation
   * and is refused outright rather than queued as a half-record.
   */
  async importExportedOffer(fields: ExportedOfferFields, bannerFile: Express.Multer.File | undefined) {
    if (!fields.merchantName?.trim()) throw new BadRequestException('merchantName is required');
    if (!fields.offerTitle?.trim()) throw new BadRequestException('offerTitle is required');
    if (!fields.address?.trim()) throw new BadRequestException('address is required');
    if (fields.offerPrice == null || Number.isNaN(fields.offerPrice)) {
      throw new BadRequestException(
        'offerPrice is required — an offer without a resolved price cannot have an approved banner and must be corrected in the AI Offer Collector before export.',
      );
    }

    const existing = await this.prisma.aiOfferFromOnline.findUnique({
      where: { collector_offer_id: fields.collectorOfferId },
    });

    // The exact banner a human approved in the Collector, copied
    // byte-for-byte into this app's storage. Never regenerated, never
    // redesigned, never replaced. Required on a first export; a re-export
    // may omit it and keep the one already stored.
    let bannerImageUrl = existing?.banner_image_url ?? null;
    if (bannerFile) {
      bannerImageUrl = await this.storage.uploadFile(bannerFile, BANNER_FOLDER);
    }
    if (!bannerImageUrl) {
      throw new BadRequestException(
        'banner is required — the AI Offer Collector must export the human-approved banner image with the offer.',
      );
    }

    const data = {
      merchant_name: fields.merchantName,
      mobile: fields.mobile || null,
      whatsapp: fields.whatsapp || null,
      category: fields.category || null,
      address: fields.address,
      city: fields.city || null,
      offer_title: fields.offerTitle,
      description: fields.description || null,
      original_price: fields.originalPrice ?? null,
      offer_price: fields.offerPrice,
      validity_start: fields.validityStart ? new Date(fields.validityStart) : null,
      validity_end: fields.validityEnd ? new Date(fields.validityEnd) : null,
      terms: fields.terms || null,
      banner_image_url: bannerImageUrl,
      source_url: fields.sourceUrl || null,
      source_type: fields.sourceType || null,
      field_provenance: fields.fieldProvenance ?? {},
    };

    // A terminal row (already PUBLISHED/REJECTED) keeps its content updated
    // for audit purposes but its STATUS is never silently reopened by a
    // re-export — that would let a rejected offer sneak back into the
    // active queue, or a live offer look unpublished, without a human
    // decision either way.
    const nextStatus =
      existing && TERMINAL_STATUSES.includes(existing.status)
        ? existing.status
        : (existing?.status ?? AiOfferFromOnlineStatus.PENDING_ADMIN_REVIEW);

    // upsert, not a manual create-or-update branch: collector_offer_id is
    // unique, and two exports racing for the same offer (a retried request,
    // a double-click) must resolve atomically at the database level, never
    // bubble a P2002 unique-constraint violation up as an unhandled 500.
    const saved = await this.prisma.aiOfferFromOnline.upsert({
      where: { collector_offer_id: fields.collectorOfferId },
      create: { collector_offer_id: fields.collectorOfferId, status: nextStatus, ...data },
      update: { ...data, status: nextStatus },
    });

    this.logger.log(
      `AI Offer From Online ${existing ? 'updated' : 'imported'}: ${saved.id} (collector offer ${fields.collectorOfferId}), status=${saved.status}`,
    );
    return { id: saved.id, status: saved.status };
  }

  // ---------------------------------------------------------------------
  // List / detail / business search.
  // ---------------------------------------------------------------------

  async list(status?: AiOfferFromOnlineStatus) {
    return this.prisma.aiOfferFromOnline.findMany({
      where: status ? { status } : undefined,
      orderBy: { exported_at: 'desc' },
    });
  }

  private async load(id: string) {
    const offer = await this.prisma.aiOfferFromOnline.findUnique({ where: { id } });
    if (!offer) throw new NotFoundException('AI offer not found');
    return offer;
  }

  /** Plain read — no Collector call, no polling. Everything needed is already here. */
  async get(id: string) {
    return this.load(id);
  }

  async searchBusinesses(q: string) {
    return this.offerPublisherService.searchBusinesses(q);
  }

  // ---------------------------------------------------------------------
  // Merchant matching — explicit admin decision only, never automatic.
  // ---------------------------------------------------------------------

  async matchBusiness(id: string, businessId: string) {
    const offer = await this.load(id);
    if (TERMINAL_STATUSES.includes(offer.status)) {
      throw new BadRequestException(`Cannot change the business match on a ${offer.status} offer`);
    }
    const business = await this.prisma.business.findUnique({ where: { id: businessId }, select: { id: true } });
    if (!business) throw new NotFoundException('Business not found');

    return this.prisma.aiOfferFromOnline.update({
      where: { id },
      data: { matched_business_id: businessId, created_business_id: null, status: AiOfferFromOnlineStatus.MERCHANT_MATCHED },
    });
  }

  /** Creates a brand-new UNCLAIMED merchant from this offer's own fields — the ONLY place a new Business is ever created from this queue, and only on an explicit admin action. Never happens at export time. */
  async createMerchant(id: string) {
    const offer = await this.load(id);
    if (TERMINAL_STATUSES.includes(offer.status)) {
      throw new BadRequestException(`Cannot create a merchant for a ${offer.status} offer`);
    }

    const { businessId } = await this.draftCreation.matchOrCreateBusiness({
      merchantName: offer.merchant_name,
      mobile: offer.mobile,
      category: offer.category,
      address: offer.address,
      city: offer.city,
    });

    return this.prisma.aiOfferFromOnline.update({
      where: { id },
      data: { created_business_id: businessId, matched_business_id: null, status: AiOfferFromOnlineStatus.MERCHANT_MATCHED },
    });
  }

  // ---------------------------------------------------------------------
  // Field corrections — provenance tracked, never silently overwritten.
  // ---------------------------------------------------------------------

  async correct(id: string, fields: CorrectOfferFields) {
    const offer = await this.load(id);
    if (TERMINAL_STATUSES.includes(offer.status)) {
      throw new BadRequestException(`Cannot edit a ${offer.status} offer`);
    }

    const provenance = { ...((offer.field_provenance as Record<string, string> | null) ?? {}) };
    for (const key of Object.keys(fields) as (keyof CorrectOfferFields)[]) {
      if (fields[key] !== undefined) provenance[key] = 'ADMIN_ENTERED';
    }

    return this.prisma.aiOfferFromOnline.update({
      where: { id },
      data: {
        merchant_name: fields.merchantName ?? offer.merchant_name,
        mobile: fields.mobile ?? offer.mobile,
        whatsapp: fields.whatsapp ?? offer.whatsapp,
        category: fields.category ?? offer.category,
        address: fields.address ?? offer.address,
        city: fields.city ?? offer.city,
        offer_title: fields.offerTitle ?? offer.offer_title,
        description: fields.description ?? offer.description,
        original_price: fields.originalPrice ?? offer.original_price,
        offer_price: fields.offerPrice ?? offer.offer_price,
        terms: fields.terms ?? offer.terms,
        field_provenance: provenance,
      },
    });
  }

  // ---------------------------------------------------------------------
  // Publish — single and bulk.
  // ---------------------------------------------------------------------

  /**
   * Takes one queued offer all the way live: creates the real Offer(DRAFT)
   * against the admin-chosen business, then hands it to the SAME Offer
   * Publisher logic every other offer goes through (approveDraft applies
   * its missing-field validation, publishDraft flips it ACTIVE) — never
   * reimplemented here, so the existing Offer Publisher state machine is
   * untouched.
   *
   * Idempotent: an offer that already produced a Pairley Offer reuses it
   * rather than creating a duplicate.
   */
  async publish(id: string) {
    const offer = await this.load(id);

    if (offer.status === AiOfferFromOnlineStatus.PUBLISHED) {
      throw new BadRequestException('This offer is already published');
    }
    if (offer.status === AiOfferFromOnlineStatus.REJECTED) {
      throw new BadRequestException('Cannot publish a rejected offer');
    }

    const businessId = offer.matched_business_id ?? offer.created_business_id;
    if (!businessId) {
      throw new BadRequestException(
        'No business matched or created for this offer yet — match an existing business or create the merchant first',
      );
    }

    // Reuse an Offer from a previous partial attempt rather than creating a
    // second one (publish idempotency).
    let offerId = offer.created_offer_id;
    if (offerId) {
      const existingOffer = await this.prisma.offer.findUnique({ where: { id: offerId }, select: { id: true } });
      if (!existingOffer) offerId = null;
    }

    if (!offerId) {
      const now = new Date();
      const thirtyDaysOut = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const created = await this.prisma.offer.create({
        data: {
          business_id: businessId,
          title: offer.offer_title,
          description: offer.description || '',
          offer_type: OfferType.STANDARD,
          category: this.categoryService.normalizeForStorage(offer.category),
          // Pairley's own placeholder for "no original price" — never a fact
          // this queue asserts (same convention Offer Publisher and
          // bulk-import both already use).
          original_price: offer.original_price ?? 0,
          offer_price: offer.offer_price,
          required_people: 1,
          start_date: now,
          end_date: offer.validity_end ?? thirtyDaysOut,
          whatsapp_number: offer.whatsapp,
          terms: offer.terms,
          // The Collector's human-approved banner IS the offer creative.
          cover_image: offer.banner_image_url,
          status: OfferStatus.DRAFT,
          source: Source.ADMIN,
          original_import_url: offer.source_url,
          original_import_source: offer.source_type,
        },
      });
      offerId = created.id;

      await this.prisma.aiOfferFromOnline.update({
        where: { id },
        data: { created_offer_id: offerId },
      });
    }

    // Fill gaps on the chosen business (a matched EXISTING business may have
    // blanks Offer Publisher's own approve() would otherwise refuse on).
    // Best-effort — a unique-mobile collision must not block publishing;
    // approveDraft below surfaces anything genuinely missing.
    await this.prisma.business
      .update({
        where: { id: businessId },
        data: {
          mobile: offer.mobile ?? undefined,
          address: offer.address || undefined,
          city: offer.city || undefined,
        },
      })
      .catch(() => undefined);

    // Resume from wherever a previous attempt stopped rather than replaying
    // it: approveDraft accepts only a DRAFT offer and publishDraft only an
    // APPROVED one, so a retry after a partial failure (approved, then the
    // publish step errored) must skip the stage that already succeeded
    // instead of throwing "Only a DRAFT offer can be approved".
    const current = await this.prisma.offer.findUniqueOrThrow({ where: { id: offerId }, select: { status: true } });

    if (current.status === OfferStatus.DRAFT) {
      await this.offerPublisherService.approveDraft(offerId);
      await this.prisma.aiOfferFromOnline.update({
        where: { id },
        data: { status: AiOfferFromOnlineStatus.READY_TO_PUBLISH },
      });
    }

    // ACTIVE already means a prior attempt got all the way through and only
    // the bookkeeping below was lost — publishing again would throw, so fall
    // straight through to recording the terminal state.
    if (current.status !== OfferStatus.ACTIVE) {
      await this.offerPublisherService.publishDraft(offerId);
    }

    return this.prisma.aiOfferFromOnline.update({
      where: { id },
      data: { status: AiOfferFromOnlineStatus.PUBLISHED, failure_reason: null },
    });
  }

  /**
   * Publish Selected. Each offer is processed INDEPENDENTLY — one failure
   * never rolls back or blocks the others, so a 10-offer run that hits two
   * problems still publishes the other eight. Failures stay in the queue,
   * marked FAILED with a reason, and remain retryable.
   */
  async publishSelected(ids: string[]): Promise<BulkPublishResult> {
    if (!ids?.length) throw new BadRequestException('Select at least one offer to publish');

    const results: BulkPublishItemResult[] = [];

    for (const id of ids) {
      try {
        const published = await this.publish(id);
        results.push({ id, outcome: 'PUBLISHED', offerId: published.created_offer_id, error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // "No business matched" is an expected, actionable state, not a
        // failure of the system — surfaced distinctly so the admin knows
        // exactly which offers need a merchant decision.
        const needsMerchant = message.includes('No business matched or created');
        results.push({
          id,
          outcome: needsMerchant ? 'NEEDS_MERCHANT' : 'FAILED',
          offerId: null,
          error: message,
        });

        if (!needsMerchant) {
          await this.prisma.aiOfferFromOnline
            .update({ where: { id }, data: { status: AiOfferFromOnlineStatus.FAILED, failure_reason: message } })
            .catch(() => undefined); // a bad id (already 404'd above) must not abort the rest of the batch
        }
        this.logger.warn(`Publish Selected: offer ${id} did not publish — ${message}`);
      }
    }

    const summary: BulkPublishResult = {
      published: results.filter((r) => r.outcome === 'PUBLISHED').length,
      needsMerchant: results.filter((r) => r.outcome === 'NEEDS_MERCHANT').length,
      failed: results.filter((r) => r.outcome === 'FAILED').length,
      results,
    };
    this.logger.log(
      `Publish Selected: ${summary.published} published, ${summary.needsMerchant} need a merchant, ${summary.failed} failed (of ${ids.length})`,
    );
    return summary;
  }

  async reject(id: string, reason?: string) {
    const offer = await this.load(id);
    if (TERMINAL_STATUSES.includes(offer.status)) {
      throw new BadRequestException(`Offer is already ${offer.status}`);
    }
    return this.prisma.aiOfferFromOnline.update({
      where: { id },
      data: { status: AiOfferFromOnlineStatus.REJECTED, rejection_reason: reason || null },
    });
  }
}
