import { Injectable, Logger } from '@nestjs/common';
import { Business, EnrichmentStatus, Offer, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EnrichmentProvider } from './enrichment-provider';

// Module 11 Phase 3 — runs after CandidateOfferService has created the
// Business/Offer rows (same wiring point as DuplicateDetectionService),
// producing suggestions only: tags/keywords are new, previously-empty
// fields safe to populate directly, but nothing here ever touches
// Offer.category, Offer.offer_type, or Business.business_type — those stay
// exactly as extraction/normalization left them until an admin explicitly
// accepts a suggestion in Phase 4. enrichment_metadata carries the full
// per-field explainability trail (Decision 6) regardless of what did or
// didn't get applied.
@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name);

  constructor(
    private readonly provider: EnrichmentProvider,
    private readonly prisma: PrismaService,
  ) {}

  async enrichAndPersist(offer: Offer, business: Business): Promise<void> {
    try {
      const result = await this.provider.enrich({
        title: offer.title,
        description: offer.description,
        currentCategory: offer.category,
        currentOfferType: offer.offer_type,
      });

      const confidences = [
        result.category.confidence,
        result.offerType.confidence,
        result.merchantType.confidence,
        result.tags.confidence,
        result.keywords.confidence,
      ];
      const overallConfidence =
        Math.round(
          (confidences.reduce((sum, c) => sum + c, 0) / confidences.length) *
            100,
        ) / 100;

      await this.prisma.offer.update({
        where: { id: offer.id },
        data: {
          tags: result.tags.suggested,
          keywords: result.keywords.suggested,
          enrichment_status: EnrichmentStatus.ENRICHED,
          enrichment_confidence: overallConfidence,
          enrichment_metadata: result as unknown as Prisma.InputJsonValue,
        },
      });

      await this.prisma.business.update({
        where: { id: business.id },
        data: { suggested_merchant_type: result.merchantType.suggested },
      });

      this.logger.log(
        `Offer ${offer.id} enriched — category suggestion="${result.category.suggested}" confidence=${overallConfidence}`,
      );
    } catch (err) {
      this.logger.error(
        `Enrichment failed for offer=${offer.id} — continuing without enrichment`,
        err instanceof Error ? err.stack : undefined,
      );
      // Best-effort status write only — if even this fails, the offer
      // simply stays at its default NOT_ENRICHED status, which is a safe,
      // already-handled state everywhere this field is read.
      await this.prisma.offer
        .update({
          where: { id: offer.id },
          data: { enrichment_status: EnrichmentStatus.ENRICHMENT_FAILED },
        })
        .catch(() => undefined);
    }
  }
}
