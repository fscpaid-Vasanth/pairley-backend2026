import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Offer, OfferStatus, Prisma, Source } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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

// Self-contained on the offer's own already-persisted fields — no lookup
// against the originating ImportJob needed, since CandidateOfferService
// bakes its placeholder defaults into the offer row itself. Kept in sync
// with the warning text CandidateOfferService generates at creation time.
function computeExtractionWarnings(offer: {
  original_price: number;
  description: string;
  cover_image: string | null;
  confidence_score: number | null;
}): string[] {
  const warnings: string[] = [];
  if (offer.original_price === 0) warnings.push('No price detected');
  if (!offer.cover_image) warnings.push('No image detected');
  if (offer.description === 'No description available.')
    warnings.push('No description detected');
  if (offer.confidence_score !== null && offer.confidence_score < 0.5) {
    warnings.push('Low overall confidence — review carefully');
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

function toCandidateSummary(
  offer: Offer & { business: { business_name: string } | null },
) {
  return {
    id: offer.id,
    title: offer.title,
    business_name: offer.business?.business_name ?? 'Unknown Business',
    source: offer.source,
    confidence_score: offer.confidence_score,
    imported_at: offer.imported_at,
    original_price: offer.original_price,
    offer_price: offer.offer_price,
    category: offer.category,
    review_status: deriveReviewStatus(offer),
    warnings: computeExtractionWarnings(offer),
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
        include: { business: { select: { business_name: true } } },
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
    return { ...toCandidateSummary(offer), business: offer.business, history };
  }

  async approve(id: string, adminId: string) {
    return this.transition(
      id,
      adminId,
      { status: OfferStatus.ACTIVE, review_required: false },
      'REVIEW_APPROVED',
    );
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
    return offer as Offer & { business: { business_name: string } | null };
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
