import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Offer, OfferStatus, OfferType, Prisma, Source } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Module 11 Phase 4 — what an admin can atomically apply at approval time.
// Every field is optional and independent: an omitted field means "keep
// whatever extraction/normalization already set," exactly like every other
// additive default in this module. enrichment_metadata itself is NEVER
// touched by applying overrides — it stays a frozen record of what was
// originally suggested, so comparing it against the live offer fields after
// approval is itself the audit trail of what the admin accepted, edited, or
// rejected.
//
// Module 14 Phase 1 widened this from the original five AI-suggestion
// fields to the full editable candidate, because the admin now reviews an
// extracted offer end to end rather than only accepting/rejecting
// suggestions. Same contract throughout: every field optional, omitted
// means unchanged. Deliberately no new columns — every field here maps to
// one that already exists on Offer or Business.
export interface CandidateOverrides {
  // Offer — AI suggestion fields (Module 11)
  category?: string;
  offerType?: OfferType;
  tags?: string[];
  keywords?: string[];
  // Offer — core content
  title?: string;
  description?: string;
  subtitle?: string;
  originalPrice?: number;
  offerPrice?: number;
  requiredPeople?: number;
  startDate?: Date;
  endDate?: Date;
  coverImage?: string;
  // Business — identity and contact. merchantType predates this and maps to
  // Business.business_type; the rest are new in Module 14 Phase 1.
  merchantType?: string;
  businessName?: string;
  businessCategory?: string;
  businessMobile?: string;
  businessEmail?: string;
  businessAddress?: string;
  businessCity?: string;
  businessState?: string;
  businessPincode?: string;
  businessWebsite?: string;
  businessGstNumber?: string;
}

export type ReviewStatus =
  | 'REVIEW_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'TAKEN_DOWN';

export function deriveReviewStatus(offer: {
  status: OfferStatus;
  review_required: boolean;
}): ReviewStatus {
  if (offer.review_required) return 'REVIEW_REQUIRED';
  if (offer.status === OfferStatus.ACTIVE) return 'APPROVED';
  if (offer.status === OfferStatus.REJECTED) return 'REJECTED';
  if (offer.status === OfferStatus.ARCHIVED) return 'TAKEN_DOWN';
  return 'REVIEW_REQUIRED';
}

type BusinessDuplicateFields = {
  duplicate_of_business_id: string | null;
  duplicate_score: number | null;
  duplicate_reasons: string[];
};

// Self-contained on the offer's own already-persisted fields — no lookup
// against the originating ImportJob needed, since CandidateOfferService
// bakes its placeholder defaults into the offer row itself. Kept in sync
// with the warning text CandidateOfferService generates at creation time.
function computeExtractionWarnings(offer: {
  original_price: number;
  description: string;
  cover_image: string | null;
  confidence_score: number | null;
  duplicate_of_offer_id: string | null;
  business?: BusinessDuplicateFields | null;
}): string[] {
  const warnings: string[] = [];
  if (offer.original_price === 0) warnings.push('No price detected');
  if (!offer.cover_image) warnings.push('No image detected');
  if (offer.description === 'No description available.')
    warnings.push('No description detected');
  if (offer.confidence_score !== null && offer.confidence_score < 0.5) {
    warnings.push('Low overall confidence — review carefully');
  }
  // Module 11 Phase 2 — recommendation only (Decision 4): a warning, never
  // a block. The admin sees this alongside every other extraction warning
  // and always makes the final call.
  if (offer.duplicate_of_offer_id) {
    warnings.push('Possible duplicate offer detected — please verify');
  }
  if (offer.business?.duplicate_of_business_id) {
    warnings.push('Possible duplicate business detected — please verify');
  }
  warnings.push('Category defaulted — please verify');
  return warnings;
}

const REVIEW_STATUS_WHERE: Record<ReviewStatus, Prisma.OfferWhereInput> = {
  REVIEW_REQUIRED: { review_required: true },
  APPROVED: { review_required: false, status: OfferStatus.ACTIVE },
  REJECTED: { review_required: false, status: OfferStatus.REJECTED },
  TAKEN_DOWN: { review_required: false, status: OfferStatus.ARCHIVED },
};

type CandidateBusiness = { business_name: string } & BusinessDuplicateFields;

function toCandidateSummary(
  offer: Offer & { business: CandidateBusiness | null },
) {
  return {
    id: offer.id,
    title: offer.title,
    description: offer.description,
    business_name: offer.business?.business_name ?? 'Unknown Business',
    source: offer.source,
    confidence_score: offer.confidence_score,
    imported_at: offer.imported_at,
    original_price: offer.original_price,
    offer_price: offer.offer_price,
    category: offer.category,
    review_status: deriveReviewStatus(offer),
    warnings: computeExtractionWarnings(offer),
    // Module 10 Phase 3 — the original uploaded poster/PDF's storage
    // location, so the admin review UI can render it alongside the
    // extracted fields for comparison before approving. Meaningless for
    // WEBSITE candidates (it's the source webpage, not an image/PDF) —
    // the frontend only renders a preview when source is PDF/POSTER.
    source_file_url: offer.original_import_url,
    // Module 11 Phase 2 — recommendation only, never auto-merged/rejected
    // (Decision 4). duplicate_of_offer_id is null unless
    // DuplicateDetectionService found a match above threshold.
    duplicate_of_offer_id: offer.duplicate_of_offer_id,
    duplicate_score: offer.duplicate_score,
    duplicate_reasons: offer.duplicate_reasons,
    business_duplicate_of_id: offer.business?.duplicate_of_business_id ?? null,
    business_duplicate_score: offer.business?.duplicate_score ?? null,
    business_duplicate_reasons: offer.business?.duplicate_reasons ?? [],
  };
}

// Module 9 Phase 3 — the admin-facing side of the review-first workflow:
// Imported -> Review Required -> Approved/Rejected -> Published. Every
// transition here writes an OfferVersion row carrying the acting admin's
// id, giving a full audit trail for free from the existing append-only
// model (no new schema needed). Approve/reject/takedown are all just
// status+review_required transitions — nothing is ever hard-deleted, so
// every transition is reversible by calling a different one of these three
// methods again.
@Injectable()
export class ReviewQueueService {
  constructor(private readonly prisma: PrismaService) {}

  async listCandidates(filters: {
    search?: string;
    reviewStatus?: ReviewStatus;
    page: number;
    pageSize: number;
  }) {
    const page = Math.max(1, filters.page || 1);
    const pageSize = Math.min(100, Math.max(1, filters.pageSize || 20));

    const where: Prisma.OfferWhereInput = {
      source: { not: Source.MANUAL },
      ...(filters.reviewStatus
        ? REVIEW_STATUS_WHERE[filters.reviewStatus]
        : {}),
      ...(filters.search
        ? {
            OR: [
              { title: { contains: filters.search, mode: 'insensitive' } },
              {
                business: {
                  business_name: {
                    contains: filters.search,
                    mode: 'insensitive',
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.offer.findMany({
        where,
        include: {
          business: {
            select: {
              business_name: true,
              duplicate_of_business_id: true,
              duplicate_score: true,
              duplicate_reasons: true,
            },
          },
        },
        orderBy: { imported_at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.offer.count({ where }),
    ]);

    return {
      items: items.map(toCandidateSummary),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async getCandidate(id: string) {
    const offer = await this.findCandidateOrThrow(id, { business: true });
    const history = await this.prisma.offerVersion.findMany({
      where: { offer_id: id },
      orderBy: { version_no: 'asc' },
    });
    // Module 14 Phase 1 — the originating import job carries what the
    // pipeline actually read off the source (raw extracted fields, per-run
    // warnings, OCR confidence). Surfacing it lets the review screen put
    // "what we found" next to "what Pairley will publish", which is the
    // comparison an admin needs to judge an extraction rather than just
    // read it. There's no FK in either direction — ImportJob points at the
    // offer it created — so this is a lookup, not an include.
    const importJob = await this.prisma.importJob.findFirst({
      where: { created_offer_id: id },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        source_type: true,
        source_url: true,
        status: true,
        extracted_fields: true,
        created_at: true,
      },
    });

    return {
      ...toCandidateSummary(offer),
      business: offer.business,
      history,
      import_job: importJob,
      // The remaining editable offer fields. toCandidateSummary stays lean
      // for the paginated table; the detail view is where the full record
      // is worth sending.
      subtitle: offer.subtitle,
      required_people: offer.required_people,
      start_date: offer.start_date,
      end_date: offer.end_date,
      cover_image: offer.cover_image,
      // Module 11 Phase 4 — the AI Suggestions panel needs the full
      // enrichment picture, not just the lean fields listCandidates
      // returns for the paginated table. Deliberately kept off
      // toCandidateSummary/listCandidates to avoid bloating every row of
      // every page with a full explainability JSON blob most rows won't
      // ever have their detail view opened for.
      offer_type: offer.offer_type,
      tags: offer.tags,
      keywords: offer.keywords,
      enrichment_status: offer.enrichment_status,
      enrichment_confidence: offer.enrichment_confidence,
      enrichment_metadata: offer.enrichment_metadata,
    };
  }

  // Overrides are optional and applied atomically with the approval itself
  // — no separate "save draft" round trip is required, though saveDraft()
  // below exists for the admin who wants to stop partway. This is the one
  // transition that doesn't go through the shared transition() helper: it
  // needs to conditionally touch the Business row too in the same
  // transaction, which reject/takedown never do.
  async approve(id: string, adminId: string, overrides?: CandidateOverrides) {
    return this.applyOverrides(id, adminId, overrides, {
      changeType: 'REVIEW_APPROVED',
      statusChange: { status: OfferStatus.ACTIVE, review_required: false },
    });
  }

  // Module 14 Phase 1 — persist an admin's in-progress edits without
  // publishing. Deliberately shares approve()'s exact override-application
  // path so a saved draft and a direct approval can never diverge in how
  // they interpret the same payload; the only difference is that no status
  // transition is applied, so the candidate stays in the review queue.
  async saveDraft(id: string, adminId: string, overrides?: CandidateOverrides) {
    return this.applyOverrides(id, adminId, overrides, {
      changeType: 'REVIEW_DRAFT_SAVED',
    });
  }

  private async applyOverrides(
    id: string,
    adminId: string,
    overrides: CandidateOverrides | undefined,
    options: {
      changeType: string;
      statusChange?: Prisma.OfferUpdateInput;
    },
  ) {
    const offer = await this.findCandidateOrThrow(id);
    this.assertCoherent(offer, overrides);

    const offerData = this.buildOfferUpdate(overrides);
    const businessData = this.buildBusinessUpdate(overrides);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingVersionCount = await tx.offerVersion.count({
          where: { offer_id: id },
        });
        await tx.offerVersion.create({
          data: {
            offer_id: id,
            version_no: existingVersionCount + 1,
            snapshot: offer,
            changed_by: adminId,
            change_type: options.changeType,
          },
        });

        const updatedOffer = await tx.offer.update({
          where: { id },
          data: { ...offerData, ...(options.statusChange ?? {}) },
        });

        if (Object.keys(businessData).length > 0) {
          await tx.business.update({
            where: { id: offer.business_id },
            data: businessData,
          });
        }

        return updatedOffer;
      });
    } catch (err) {
      // Business.mobile and Business.email are both @unique. An admin
      // correcting an extracted phone number can legitimately collide with
      // a business already on Pairley — that's a duplicate to resolve via
      // consolidation, not a server error, so it gets a message saying so.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const fields = (err.meta?.target as string[] | undefined) ?? [];
        const label = fields.includes('email')
          ? 'email address'
          : fields.includes('mobile')
            ? 'mobile number'
            : 'value';
        throw new BadRequestException(
          `Another business already uses this ${label}. It may be a duplicate — check Business Duplicates before continuing.`,
        );
      }
      throw err;
    }
  }

  // Validates the *effective* result (stored value where the admin didn't
  // override it), not just the submitted payload — editing only one side of
  // a pair is the common case and it still has to end up coherent.
  private assertCoherent(offer: Offer, overrides?: CandidateOverrides) {
    if (!overrides) return;

    const originalPrice = overrides.originalPrice ?? offer.original_price;
    const offerPrice = overrides.offerPrice ?? offer.offer_price;
    if (offerPrice > originalPrice) {
      throw new BadRequestException(
        'Offer price cannot be higher than the original price.',
      );
    }

    const startDate = overrides.startDate ?? offer.start_date;
    const endDate = overrides.endDate ?? offer.end_date;
    if (endDate <= startDate) {
      throw new BadRequestException('End date must be after the start date.');
    }
  }

  private buildOfferUpdate(
    overrides?: CandidateOverrides,
  ): Prisma.OfferUpdateInput {
    if (!overrides) return {};
    return {
      ...(overrides.category !== undefined
        ? { category: overrides.category }
        : {}),
      ...(overrides.offerType !== undefined
        ? { offer_type: overrides.offerType }
        : {}),
      ...(overrides.tags !== undefined ? { tags: overrides.tags } : {}),
      ...(overrides.keywords !== undefined
        ? { keywords: overrides.keywords }
        : {}),
      ...(overrides.title !== undefined ? { title: overrides.title } : {}),
      ...(overrides.description !== undefined
        ? { description: overrides.description }
        : {}),
      ...(overrides.subtitle !== undefined
        ? { subtitle: overrides.subtitle }
        : {}),
      ...(overrides.originalPrice !== undefined
        ? { original_price: overrides.originalPrice }
        : {}),
      ...(overrides.offerPrice !== undefined
        ? { offer_price: overrides.offerPrice }
        : {}),
      ...(overrides.requiredPeople !== undefined
        ? { required_people: overrides.requiredPeople }
        : {}),
      ...(overrides.startDate !== undefined
        ? { start_date: overrides.startDate }
        : {}),
      ...(overrides.endDate !== undefined
        ? { end_date: overrides.endDate }
        : {}),
      ...(overrides.coverImage !== undefined
        ? { cover_image: overrides.coverImage }
        : {}),
    };
  }

  private buildBusinessUpdate(
    overrides?: CandidateOverrides,
  ): Prisma.BusinessUpdateInput {
    if (!overrides) return {};
    return {
      ...(overrides.merchantType !== undefined
        ? { business_type: overrides.merchantType }
        : {}),
      ...(overrides.businessName !== undefined
        ? { business_name: overrides.businessName }
        : {}),
      ...(overrides.businessCategory !== undefined
        ? { category: overrides.businessCategory }
        : {}),
      ...(overrides.businessMobile !== undefined
        ? { mobile: overrides.businessMobile }
        : {}),
      ...(overrides.businessEmail !== undefined
        ? { email: overrides.businessEmail }
        : {}),
      ...(overrides.businessAddress !== undefined
        ? { address: overrides.businessAddress }
        : {}),
      ...(overrides.businessCity !== undefined
        ? { city: overrides.businessCity }
        : {}),
      ...(overrides.businessState !== undefined
        ? { state: overrides.businessState }
        : {}),
      ...(overrides.businessPincode !== undefined
        ? { pincode: overrides.businessPincode }
        : {}),
      ...(overrides.businessWebsite !== undefined
        ? { website: overrides.businessWebsite }
        : {}),
      ...(overrides.businessGstNumber !== undefined
        ? { gst_number: overrides.businessGstNumber }
        : {}),
    };
  }

  async reject(id: string, adminId: string, reason?: string) {
    return this.transition(
      id,
      adminId,
      { status: OfferStatus.REJECTED, review_required: false },
      'REVIEW_REJECTED',
      reason,
    );
  }

  async takedown(id: string, adminId: string) {
    return this.transition(
      id,
      adminId,
      { status: OfferStatus.ARCHIVED, review_required: false },
      'REVIEW_TAKEDOWN',
    );
  }

  async bulkApprove(ids: string[], adminId: string) {
    return this.bulk(ids, (id) => this.approve(id, adminId));
  }

  async bulkReject(ids: string[], adminId: string, reason?: string) {
    return this.bulk(ids, (id) => this.reject(id, adminId, reason));
  }

  private async bulk(ids: string[], action: (id: string) => Promise<unknown>) {
    const succeeded: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try {
        await action(id);
        succeeded.push(id);
      } catch (err) {
        failed.push({
          id,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
    return { succeeded, failed };
  }

  private async findCandidateOrThrow(
    id: string,
    include?: Prisma.OfferInclude,
  ) {
    const offer = await this.prisma.offer.findUnique({
      where: { id },
      include,
    });
    if (!offer) {
      throw new NotFoundException('Candidate offer not found');
    }
    if (offer.source === Source.MANUAL) {
      throw new ForbiddenException(
        'This offer was not AI-imported and is not part of the review queue',
      );
    }
    return offer as Offer & { business: CandidateBusiness | null };
  }

  private async transition(
    id: string,
    adminId: string,
    data: Prisma.OfferUpdateInput,
    changeType: string,
    reason?: string,
  ) {
    const offer = await this.findCandidateOrThrow(id);

    const existingVersionCount = await this.prisma.offerVersion.count({
      where: { offer_id: id },
    });
    await this.prisma.offerVersion.create({
      data: {
        offer_id: id,
        version_no: existingVersionCount + 1,
        snapshot: reason ? { ...offer, _reason: reason } : offer,
        changed_by: adminId,
        change_type: changeType,
      },
    });

    return this.prisma.offer.update({ where: { id }, data });
  }
}
