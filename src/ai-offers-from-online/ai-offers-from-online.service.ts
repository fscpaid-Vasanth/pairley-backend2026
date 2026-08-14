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
import { AiOfferDuplicateDetectionService } from './duplicate-detection.service';

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
  /** Raw, as-reported-by-the-Collector price signal — audit only, never read by publish()/classifyForPublish. */
  sourcePrice?: number;
  sourceCurrency?: string;
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
export type BulkPublishOutcome = 'PUBLISHED' | 'DUPLICATE' | 'CATEGORY_REQUIRED' | 'EXPIRED' | 'FAILED';

export interface BulkPublishItemResult {
  id: string;
  outcome: BulkPublishOutcome;
  offerId: string | null;
  error: string | null;
}

export interface BulkPublishResult {
  published: number;
  duplicate: number;
  categoryRequired: number;
  expired: number;
  failed: number;
  results: BulkPublishItemResult[];
}

/**
 * The outcome of one offer inside a dry-run validation pass — see
 * validateSelected(). Deliberately the SAME vocabulary publish() itself now
 * persists to AiOfferFromOnlineStatus (CATEGORY_REQUIRED/EXPIRED), plus
 * READY (not itself a stored status — the offer just has nothing blocking
 * it) and OTHER_FAILURE (terminal/unknown — never a genuine processing
 * error, which only ever shows up as FAILED after a real publish attempt,
 * not in a dry run that touches nothing). Price is NOT part of this
 * vocabulary (2026-08-14) — a null offer_price never blocks readiness.
 */
export type ValidationOutcome = 'READY' | 'CATEGORY_REQUIRED' | 'EXPIRED' | 'OTHER_FAILURE';

export interface ValidationItemResult {
  id: string;
  outcome: ValidationOutcome;
  /** Blocking reason, present for every non-READY outcome. */
  message: string | null;
  /**
   * Informational only, never blocking: set on a READY item whose raw
   * category text will be silently normalized at publish time (e.g. the
   * Collector's "Restaurants/Buffets" resolving to "dining"), so an admin
   * can see what happened without it counting against readiness.
   */
  categoryNote: string | null;
}

export interface DryRunValidationResult {
  total: number;
  readyToPublish: number;
  categoryRequired: number;
  expired: number;
  otherFailures: number;
  items: ValidationItemResult[];
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
 * that.
 *
 * Merchant onboarding is NOT a publishing prerequisite (2026-08-11):
 * publish() uses an admin's explicit match/create-merchant choice when one
 * was made, and otherwise auto-resolves a business itself via
 * matchOrCreateBusiness — reusing an existing business on an exact
 * mobile or (normalized name + normalized city) match, or creating a new
 * UNCLAIMED one from this offer's own extracted fields. No phone
 * verification, KYC, GST, or claim is ever required first; UNCLAIMED is
 * already this codebase's normal, fully-supported "AI-imported, no owner
 * yet" state (see BusinessStatus, ClaimRequestService, and the
 * customer-facing "Is this your business? Claim it" prompt — none of that
 * changes here). A HIGH-confidence duplicate (AiOfferDuplicateDetectionService)
 * still blocks publish and never touches Business/Offer either.
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
    private readonly duplicateDetection: AiOfferDuplicateDetectionService,
  ) {}

  // ---------------------------------------------------------------------
  // Export intake (from the Collector) — upsert by collector_offer_id.
  // ---------------------------------------------------------------------

  /**
   * Accepts one fully-ready offer exported from the Collector. An approved
   * banner is REQUIRED — the Collector cannot export without one, so a
   * missing banner is a contract violation, refused outright rather than
   * queued as a half-record.
   *
   * offerPrice is NOT required (2026-08-11): the Collector's own readiness
   * gate already decided this offer may export with no numeric price,
   * because it carries a verified non-price promotional mechanic instead
   * (stated discount percentage, BOGO, BOGT, or an explicit free-benefit
   * offer) — Pairley trusts that decision rather than re-deriving it, the
   * same way it already trusts "an approved banner exists" without asking
   * why. When offerPrice IS provided, it must be a real, positive number —
   * never 0, never NaN from a malformed submission.
   */
  async importExportedOffer(fields: ExportedOfferFields, bannerFile: Express.Multer.File | undefined) {
    if (!fields.merchantName?.trim()) throw new BadRequestException('merchantName is required');
    if (!fields.offerTitle?.trim()) throw new BadRequestException('offerTitle is required');
    if (!fields.address?.trim()) throw new BadRequestException('address is required');
    if (fields.offerPrice !== undefined && (Number.isNaN(fields.offerPrice) || fields.offerPrice <= 0)) {
      throw new BadRequestException('offerPrice, when provided, must be a positive number — omit it entirely for a non-price promotional offer.');
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
      // Explicit null, not left undefined: every other field here always
      // reflects the Collector's latest submission (the same rule
      // merchant_name/category/address etc. already follow) — offer_price
      // is no exception. Only banner_image_url is deliberately preserved
      // across a re-export that omits it, for the documented reason above.
      offer_price: fields.offerPrice ?? null,
      source_price: fields.sourcePrice ?? null,
      source_currency: fields.sourceCurrency || 'INR',
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

  /**
   * 2026-08-12 — attaches each row's linked business's claim status
   * (business_status — UNCLAIMED/CLAIMED/etc.) so the admin grid can show
   * it without a second round-trip per card. matched_business_id/
   * created_business_id are plain scalar strings, not a formal Prisma
   * relation (see the class doc), so this is a batched second query + an
   * in-memory join — same pattern LeadService already uses for
   * WhatsApp-message status.
   */
  async list(status?: AiOfferFromOnlineStatus) {
    const offers = await this.prisma.aiOfferFromOnline.findMany({
      where: status ? { status } : undefined,
      orderBy: { exported_at: 'desc' },
    });

    const businessIds = [
      ...new Set(
        offers
          .map((o) => o.matched_business_id ?? o.created_business_id)
          .filter((id): id is string => !!id),
      ),
    ];
    if (businessIds.length === 0) {
      return offers.map((o) => ({ ...o, claim_status: null }));
    }

    const businesses = await this.prisma.business.findMany({
      where: { id: { in: businessIds } },
      select: { id: true, business_status: true },
    });
    const statusById = new Map(businesses.map((b) => [b.id, b.business_status]));

    return offers.map((o) => {
      const businessId = o.matched_business_id ?? o.created_business_id;
      return { ...o, claim_status: businessId ? (statusById.get(businessId) ?? null) : null };
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
      createdByAi: true,
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

    // A correction that resolves the exact thing a review status was
    // blocking on returns the row to the normal flow — rather than leaving
    // it stuck under a status that no longer describes it. Any OTHER edit
    // to a review-state row (e.g. fixing the title while still
    // category-required) leaves the status untouched.
    //
    // The PRICE_REQUIRED branch below is legacy-only (2026-08-14): publish()
    // no longer assigns this status to anything, but a row already sitting
    // in it from before this change should still recover cleanly if an
    // admin patches a price into it before the one-off reclassify script
    // runs — see scripts/reclassify-price-required-offers.js.
    let nextStatus = offer.status;
    if (offer.status === AiOfferFromOnlineStatus.PRICE_REQUIRED && fields.offerPrice !== undefined) {
      nextStatus = AiOfferFromOnlineStatus.PENDING_ADMIN_REVIEW;
    }
    if (offer.status === AiOfferFromOnlineStatus.CATEGORY_REQUIRED && fields.category !== undefined) {
      nextStatus = AiOfferFromOnlineStatus.PENDING_ADMIN_REVIEW;
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
        status: nextStatus,
        failure_reason: nextStatus !== offer.status ? null : offer.failure_reason,
      },
    });
  }

  // ---------------------------------------------------------------------
  // Publish — single and bulk.
  // ---------------------------------------------------------------------

  /**
   * Takes one queued offer all the way live: resolves a business (an
   * admin's explicit match/create-merchant choice if one was made,
   * otherwise auto-resolved — see class doc), runs the duplicate check,
   * then creates the real Offer(DRAFT) and hands it to the SAME Offer
   * Publisher logic every other offer goes through (approveDraft applies
   * its missing-field validation, publishDraft flips it ACTIVE) — never
   * reimplemented here, so the existing Offer Publisher state machine is
   * untouched.
   *
   * Idempotent: an offer that already produced a Pairley Offer reuses it
   * rather than creating a duplicate (and does not re-run the duplicate
   * check — that only ever gates the FIRST creation of the real Offer).
   */
  async publish(id: string) {
    const offer = await this.load(id);

    if (offer.status === AiOfferFromOnlineStatus.PUBLISHED) {
      throw new BadRequestException('This offer is already published');
    }
    if (offer.status === AiOfferFromOnlineStatus.REJECTED) {
      throw new BadRequestException('Cannot publish a rejected offer');
    }

    // Pre-flight classification — before any Business/Offer mutation is
    // attempted. EXPIRED/CATEGORY_REQUIRED are expected, admin-correctable
    // REVIEW states, never processing bugs: publish() returns normally with
    // that specific status (the same pattern DUPLICATE_SUPPRESSED already
    // uses below), rather than throwing into publishSelected()'s generic
    // FAILED catch block. category being unresolved on THIS queue table is
    // a legitimate, expected state — that's what correct() (PATCH :id) is
    // for, and it moves the row back to PENDING_ADMIN_REVIEW once supplied.
    // Price is NOT part of this gate (2026-08-14) — see the Offer creation
    // below for how a null offer_price is handled.
    const classification = this.classifyForPublish(offer);
    if (classification.outcome === 'EXPIRED' || classification.outcome === 'CATEGORY_REQUIRED') {
      return this.prisma.aiOfferFromOnline.update({
        where: { id },
        data: {
          status: AiOfferFromOnlineStatus[classification.outcome],
          failure_reason: classification.message,
        },
      });
    }

    let businessId = offer.matched_business_id ?? offer.created_business_id;
    if (!businessId) {
      // No admin match/create decision yet — auto-resolve rather than
      // block. matchOrCreateBusiness reuses an exact-mobile or
      // exact-normalized-name+city match if one exists, otherwise creates
      // a brand-new UNCLAIMED business from this offer's own extracted
      // fields. Never fake data, never KYC, never a claim requirement.
      const resolved = await this.draftCreation.matchOrCreateBusiness({
        merchantName: offer.merchant_name,
        mobile: offer.mobile,
        category: offer.category,
        address: offer.address,
        city: offer.city,
        createdByAi: true,
      });
      businessId = resolved.businessId;
      await this.prisma.aiOfferFromOnline.update({
        where: { id },
        data: { created_business_id: businessId, status: AiOfferFromOnlineStatus.MERCHANT_MATCHED },
      });
    }

    // Reuse an Offer from a previous partial attempt rather than creating a
    // second one (publish idempotency).
    let offerId = offer.created_offer_id;
    if (offerId) {
      const existingOffer = await this.prisma.offer.findUnique({ where: { id: offerId }, select: { id: true } });
      if (!existingOffer) offerId = null;
    }

    if (!offerId) {
      const duplicate = await this.duplicateDetection.check({
        businessId,
        offerTitle: offer.offer_title,
        description: offer.description,
        terms: offer.terms,
        originalPrice: offer.original_price,
        offerPrice: offer.offer_price,
        sourceUrl: offer.source_url,
      });

      // HIGH confidence only: block, and keep the decision on THIS queue
      // row (never touching Business/Offer) so it stays auditable — a
      // MEDIUM finding below is recorded on the real Offer instead, since
      // one gets created either way.
      if (duplicate.confidence === 'HIGH') {
        return this.prisma.aiOfferFromOnline.update({
          where: { id },
          data: {
            status: AiOfferFromOnlineStatus.DUPLICATE_SUPPRESSED,
            duplicate_of_offer_id: duplicate.duplicateOfferId,
            duplicate_score: duplicate.score,
            duplicate_reasons: duplicate.reasons,
            failure_reason: null,
          },
        });
      }

      const now = new Date();
      const thirtyDaysOut = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      // categoryService.normalizeForStorage() already resolves null/empty
      // to 'general' without throwing (a legitimate, non-blocking state —
      // see its own doc comment) and already carries the full deterministic
      // alias/slug/display-name resolution logic; this only intercepts the
      // genuine "no known mapping at all" case to give an admin a clearer,
      // more actionable message than a raw 12-category enum dump.
      let normalizedCategory: string;
      try {
        normalizedCategory = this.categoryService.normalizeForStorage(offer.category);
      } catch {
        throw new BadRequestException(this.categoryNotRecognizedMessage(offer.category));
      }

      const created = await this.prisma.offer.create({
        data: {
          business_id: businessId,
          title: offer.offer_title,
          description: offer.description || '',
          offer_type: OfferType.STANDARD,
          category: normalizedCategory,
          // Pairley's own placeholder for "no original price" — never a fact
          // this queue asserts (same convention Offer Publisher and
          // bulk-import both already use).
          original_price: offer.original_price ?? 0,
          // 2026-08-14 — same 0-sentinel convention as original_price above:
          // Offer.offer_price is NOT NULL on the live table, but Pairley's
          // business model doesn't require a numeric price to publish (BOGO/
          // percentage/couple/group offers are all valid without one) — 0
          // here means "no fixed price was verified", never "free". The
          // customer-facing price badge (DealCard.jsx, DealDetailPage.jsx,
          // SearchOverlay.jsx) must treat offer_price === 0 as "show the
          // offer's own title/mechanic instead of a ₹/% badge", not as a
          // real price — see those files for the corresponding guard.
          offer_price: offer.offer_price ?? 0,
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
          // MEDIUM confidence: publish proceeds, but the advisory
          // relationship is recorded on the Offer's own pre-existing
          // duplicate_* fields (Module 11 Phase 2) rather than blocking —
          // "recommendation only, never auto-merged", exactly as those
          // fields were originally documented to mean.
          ...(duplicate.confidence === 'MEDIUM'
            ? {
                duplicate_of_offer_id: duplicate.duplicateOfferId,
                duplicate_score: duplicate.score,
                duplicate_reasons: duplicate.reasons,
              }
            : {}),
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
      // allowMissingPrice: this pipeline's offer_price is a 0 sentinel when
      // no verified number exists (never fabricated), and that's fine —
      // see approveDraft()'s own doc comment.
      await this.offerPublisherService.approveDraft(offerId, true);
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

  private categoryNotRecognizedMessage(raw: string | null): string {
    const validKeys = this.categoryService.listSelectable().map((c) => c.key).join(', ');
    return `Category normalization required: "${raw}" has no known Pairley mapping. An admin must correct this offer's category (PATCH) before publishing. Valid categories: ${validKeys}`;
  }

  private expiredMessage(validityEnd: Date): string {
    return `EXPIRED: This offer's stated validity ended ${validityEnd.toISOString().slice(0, 10)}. Pairley cannot confirm whether the source page itself is still live — only that this offer's own validity window has passed.`;
  }

  /**
   * Read-only classification used by both the dry run (validateSelected)
   * and publish() itself (same precedence: terminal status, then expiry,
   * then category — so a dry run never disagrees with what publish()
   * actually does). Never touches the database.
   *
   * 2026-08-14 — price is deliberately NOT part of this classification.
   * Pairley's business model doesn't require a numeric price to publish
   * (BOGO/percentage/couple/group offers are all valid without one) — see
   * publish() below for how a null offer_price is handled once an offer
   * reaches Offer creation.
   */
  private classifyForPublish(offer: {
    status: AiOfferFromOnlineStatus;
    category: string | null;
    validity_end: Date | null;
  }): Omit<ValidationItemResult, 'id'> {
    if (TERMINAL_STATUSES.includes(offer.status)) {
      return { outcome: 'OTHER_FAILURE', message: `Offer is already ${offer.status}`, categoryNote: null };
    }
    if (offer.validity_end && offer.validity_end.getTime() < Date.now()) {
      return { outcome: 'EXPIRED', message: this.expiredMessage(offer.validity_end), categoryNote: null };
    }
    // Empty/null category is not a failure — normalizeForStorage() resolves
    // it to 'general' at publish time, exactly like this check must mirror.
    if (!offer.category?.trim()) {
      return { outcome: 'READY', message: null, categoryNote: null };
    }
    const resolved = this.categoryService.normalize(offer.category);
    if (!resolved) {
      return { outcome: 'CATEGORY_REQUIRED', message: this.categoryNotRecognizedMessage(offer.category), categoryNote: null };
    }
    const categoryNote =
      resolved !== offer.category ? `Category normalization required: ${offer.category} → ${resolved}` : null;
    return { outcome: 'READY', message: null, categoryNote };
  }

  /**
   * Dry-run validation — checks every selected offer against the same
   * category/price rules publish() enforces, WITHOUT creating or changing
   * anything (no Business, no Offer, no queue-row mutation). Meant to run
   * before a real Publish Selected so an admin sees what will actually
   * happen first, per offer, rather than discovering it one failed batch
   * at a time.
   */
  async validateSelected(ids: string[]): Promise<DryRunValidationResult> {
    if (!ids?.length) throw new BadRequestException('Select at least one offer to validate');

    const items: ValidationItemResult[] = [];
    for (const id of ids) {
      try {
        const offer = await this.load(id);
        items.push({ id, ...this.classifyForPublish(offer) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        items.push({ id, outcome: 'OTHER_FAILURE', message, categoryNote: null });
      }
    }

    return {
      total: items.length,
      readyToPublish: items.filter((i) => i.outcome === 'READY').length,
      categoryRequired: items.filter((i) => i.outcome === 'CATEGORY_REQUIRED').length,
      expired: items.filter((i) => i.outcome === 'EXPIRED').length,
      otherFailures: items.filter((i) => i.outcome === 'OTHER_FAILURE').length,
      items,
    };
  }

  /**
   * Publish Selected. Each offer is processed INDEPENDENTLY — one failure
   * never rolls back or blocks the others, so a 10-offer run that hits two
   * problems still publishes the other eight. Failures stay in the queue,
   * marked FAILED with a reason, and remain retryable. A HIGH-confidence
   * duplicate is not a failure — publish() itself returns normally with
   * DUPLICATE_SUPPRESSED, surfaced here as its own outcome.
   */
  async publishSelected(ids: string[]): Promise<BulkPublishResult> {
    if (!ids?.length) throw new BadRequestException('Select at least one offer to publish');

    const results: BulkPublishItemResult[] = [];

    // publish() returning normally with one of these statuses is an expected
    // review outcome, not a failure — same status-to-outcome mapping as
    // DUPLICATE_SUPPRESSED already used. Only a genuinely thrown error below
    // is a processing FAILED. PRICE_REQUIRED is deliberately absent
    // (2026-08-14) — publish() never assigns it anymore, so it can no
    // longer be an outcome here; any row still carrying that status from
    // before this change reclassifies to PENDING_ADMIN_REVIEW (or publishes
    // outright) the next time publish() runs on it.
    const REVIEW_STATUS_OUTCOME: Partial<Record<AiOfferFromOnlineStatus, BulkPublishOutcome>> = {
      [AiOfferFromOnlineStatus.DUPLICATE_SUPPRESSED]: 'DUPLICATE',
      [AiOfferFromOnlineStatus.CATEGORY_REQUIRED]: 'CATEGORY_REQUIRED',
      [AiOfferFromOnlineStatus.EXPIRED]: 'EXPIRED',
    };

    for (const id of ids) {
      try {
        const published = await this.publish(id);
        const reviewOutcome = REVIEW_STATUS_OUTCOME[published.status];
        if (reviewOutcome) {
          results.push({ id, outcome: reviewOutcome, offerId: null, error: published.failure_reason });
        } else {
          results.push({ id, outcome: 'PUBLISHED', offerId: published.created_offer_id, error: null });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ id, outcome: 'FAILED', offerId: null, error: message });
        await this.prisma.aiOfferFromOnline
          .update({ where: { id }, data: { status: AiOfferFromOnlineStatus.FAILED, failure_reason: message } })
          .catch(() => undefined); // a bad id (already 404'd above) must not abort the rest of the batch
        this.logger.warn(`Publish Selected: offer ${id} did not publish — ${message}`);
      }
    }

    const summary: BulkPublishResult = {
      published: results.filter((r) => r.outcome === 'PUBLISHED').length,
      duplicate: results.filter((r) => r.outcome === 'DUPLICATE').length,
      categoryRequired: results.filter((r) => r.outcome === 'CATEGORY_REQUIRED').length,
      expired: results.filter((r) => r.outcome === 'EXPIRED').length,
      failed: results.filter((r) => r.outcome === 'FAILED').length,
      results,
    };
    this.logger.log(
      `Publish Selected: ${summary.published} published, ${summary.duplicate} flagged as duplicate, ` +
        `${summary.categoryRequired} category-required, ${summary.expired} expired, ${summary.failed} failed (of ${ids.length})`,
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
