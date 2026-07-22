import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BusinessStatus, ClaimRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const PENDING_CLAIM_STATUSES = [
  ClaimRequestStatus.PENDING_ADMIN_REVIEW,
  ClaimRequestStatus.ADMIN_APPROVED,
];

const DUPLICATE_LIST_SELECT = {
  id: true,
  business_name: true,
  city: true,
  category: true,
  business_status: true,
  duplicate_score: true,
  duplicate_reasons: true,
  created_at: true,
  duplicate_of: {
    select: { id: true, business_name: true, city: true, business_status: true },
  },
};

// Module 12 Phase 4 — Business Duplicate Consolidation. Acts on the
// recommendation-only signals Module 11 Phase 2's DuplicateDetectionService
// already writes (duplicate_of_business_id/duplicate_score/duplicate_reasons)
// — nothing before this service ever merged/removed a business
// automatically; this is the first and only place that does, and only ever
// on explicit admin action.
//
// Scope is deliberately narrow: reassign Offer.business_id, soft-remove the
// duplicate (business_status -> REMOVED, never a hard delete so Subscription/
// Rating/ClaimRequest/WhatsAppMessage history on the duplicate stays intact
// and queryable), and record a separate audit trail
// (consolidated_into_business_id/consolidated_at/consolidated_by) rather
// than overloading duplicate_of_business_id, which stays a pristine record
// of the original AI suggestion whether or not an admin ever acted on it.
@Injectable()
export class BusinessConsolidationService {
  private readonly logger = new Logger(BusinessConsolidationService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Only UNCLAIMED businesses ever get flagged as duplicates of each other
  // (DuplicateDetectionService only compares within that pool — see
  // duplicate-detection.service.ts), so this list is naturally scoped to
  // AI-imported ghost listings, never a real merchant's claimed business.
  async listDuplicates() {
    return this.prisma.business.findMany({
      where: {
        duplicate_of_business_id: { not: null },
        business_status: BusinessStatus.UNCLAIMED,
      },
      select: DUPLICATE_LIST_SELECT,
      orderBy: { duplicate_score: 'desc' },
    });
  }

  async getDuplicateDetail(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      include: { duplicate_of: true },
    });
    if (!business) {
      throw new NotFoundException('Business not found');
    }

    const candidateIds = [business.id, business.duplicate_of_business_id].filter(
      (id): id is string => !!id,
    );
    const pendingClaims = await this.prisma.claimRequest.findMany({
      where: {
        business_id: { in: candidateIds },
        status: { in: PENDING_CLAIM_STATUSES },
      },
      select: { id: true, business_id: true, status: true },
    });

    return {
      ...business,
      pending_claim_on_this: pendingClaims.some((c) => c.business_id === business.id),
      pending_claim_on_canonical: pendingClaims.some(
        (c) => c.business_id === business.duplicate_of_business_id,
      ),
    };
  }

  async consolidate(
    duplicateBusinessId: string,
    canonicalBusinessId: string | undefined,
    adminId: string,
  ) {
    const duplicate = await this.prisma.business.findUnique({
      where: { id: duplicateBusinessId },
    });
    if (!duplicate) {
      throw new NotFoundException('Business not found');
    }

    const resolvedCanonicalId =
      canonicalBusinessId || duplicate.duplicate_of_business_id || undefined;
    if (!resolvedCanonicalId) {
      throw new BadRequestException(
        'canonical_business_id is required — no suggested duplicate is on file for this business',
      );
    }
    if (resolvedCanonicalId === duplicateBusinessId) {
      throw new BadRequestException(
        'Cannot consolidate a business with itself',
      );
    }

    const canonical = await this.prisma.business.findUnique({
      where: { id: resolvedCanonicalId },
    });
    if (!canonical) {
      throw new NotFoundException('Canonical business not found');
    }

    if (duplicate.business_status === BusinessStatus.REMOVED) {
      throw new BadRequestException(
        'This business has already been consolidated',
      );
    }
    if (duplicate.business_status !== BusinessStatus.UNCLAIMED) {
      throw new BadRequestException(
        'Only an unclaimed business can be consolidated away — this one already has an owner',
      );
    }
    if (canonical.business_status === BusinessStatus.REMOVED) {
      throw new BadRequestException(
        'Cannot consolidate into a business that has itself been removed',
      );
    }

    const pendingClaim = await this.prisma.claimRequest.findFirst({
      where: {
        business_id: { in: [duplicateBusinessId, resolvedCanonicalId] },
        status: { in: PENDING_CLAIM_STATUSES },
      },
    });
    if (pendingClaim) {
      throw new BadRequestException(
        'Cannot consolidate while a claim request is pending on either business — resolve it first',
      );
    }

    const [offersReassigned, updatedDuplicate] = await this.prisma.$transaction([
      this.prisma.offer.updateMany({
        where: { business_id: duplicateBusinessId },
        data: { business_id: resolvedCanonicalId },
      }),
      this.prisma.business.update({
        where: { id: duplicateBusinessId },
        data: {
          business_status: BusinessStatus.REMOVED,
          consolidated_into_business_id: resolvedCanonicalId,
          consolidated_at: new Date(),
          consolidated_by: adminId,
        },
      }),
    ]);

    this.logger.log(
      `Business ${duplicateBusinessId} consolidated into ${resolvedCanonicalId} by admin ${adminId} — ${offersReassigned.count} offer(s) reassigned`,
    );

    return {
      duplicate_business_id: duplicateBusinessId,
      canonical_business_id: resolvedCanonicalId,
      offers_reassigned: offersReassigned.count,
      business: updatedDuplicate,
    };
  }
}
