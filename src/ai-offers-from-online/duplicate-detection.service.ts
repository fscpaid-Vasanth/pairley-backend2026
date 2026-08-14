import { Injectable } from '@nestjs/common';
import { OfferStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { classifyMechanic, isLikelyOfferSpecificUrl, mechanicsEqual, normalizeUrl, titleJaccard } from './duplicate-detection';

export type DuplicateConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface DuplicateCheckInput {
  businessId: string;
  offerTitle: string;
  description?: string | null;
  terms?: string | null;
  originalPrice?: number | null;
  offerPrice?: number | null;
  sourceUrl?: string | null;
}

export interface DuplicateCheckResult {
  confidence: DuplicateConfidence;
  duplicateOfferId: string | null;
  score: number | null;
  reasons: string[];
}

const LOW_RESULT: DuplicateCheckResult = { confidence: 'LOW', duplicateOfferId: null, score: null, reasons: [] };

// Offers in these statuses are the ones a re-discovered offer could
// meaningfully collide with. EXPIRED/CLOSED/REJECTED/ARCHIVED are
// deliberately excluded — rediscovering and republishing something that
// already lapsed is a legitimate outcome, not a duplicate.
const LIVE_STATUSES: OfferStatus[] = [OfferStatus.ACTIVE, OfferStatus.DRAFT];

/**
 * Runs at publish() time only (never at export/import), against real,
 * already-existing Offer rows. Two independent tiers, evaluated in order —
 * either can return HIGH; only Tier 2 can return MEDIUM. See
 * duplicate-detection.ts's module doc for the pure classification rules
 * this composes.
 */
@Injectable()
export class AiOfferDuplicateDetectionService {
  constructor(private readonly prisma: PrismaService) {}

  async check(input: DuplicateCheckInput): Promise<DuplicateCheckResult> {
    const tier1 = await this.checkTier1SourceUrl(input);
    if (tier1) return tier1;

    const tier2 = await this.checkTier2SameBusiness(input);
    if (tier2) return tier2;

    return LOW_RESULT;
  }

  /**
   * Definite duplicate — the exact same offer-specific source page was
   * already imported into a live Offer. Never fires for a merchant
   * profile/homepage/listing URL (isLikelyOfferSpecificUrl gates that), so
   * two different real offers posted to the same Instagram profile never
   * collide here.
   */
  private async checkTier1SourceUrl(input: DuplicateCheckInput): Promise<DuplicateCheckResult | null> {
    if (!isLikelyOfferSpecificUrl(input.sourceUrl)) return null;
    const normalized = normalizeUrl(input.sourceUrl);
    if (!normalized) return null;

    const candidates = await this.prisma.offer.findMany({
      where: { status: { in: LIVE_STATUSES }, original_import_url: { not: null } },
      select: { id: true, original_import_url: true },
    });
    // Normalized in JS on both sides — original_import_url was written at
    // various points by various paths and is not guaranteed pre-normalized.
    const match = candidates.find((c) => normalizeUrl(c.original_import_url) === normalized);
    if (!match) return null;

    return {
      confidence: 'HIGH',
      duplicateOfferId: match.id,
      score: 1,
      reasons: ['same_offer_specific_source_url'],
    };
  }

  /**
   * Same merchant + same promotional mechanic + same commercial value +
   * similar title. Only ever compares within the resolved business's own
   * offers, so two different merchants' unrelated 50%-off promos never
   * collide, and never fires for OTHER-vs-OTHER (mechanicsEqual's own rule).
   */
  private async checkTier2SameBusiness(input: DuplicateCheckInput): Promise<DuplicateCheckResult | null> {
    const candidates = await this.prisma.offer.findMany({
      where: { business_id: input.businessId, status: { in: LIVE_STATUSES } },
      select: { id: true, title: true, description: true, terms: true, original_price: true, offer_price: true },
    });
    if (candidates.length === 0) return null;

    const incomingText = [input.offerTitle, input.description, input.terms].filter(Boolean).join(' ');
    const incomingMechanic = classifyMechanic(incomingText, input.originalPrice, input.offerPrice);

    let best: DuplicateCheckResult | null = null;

    for (const candidate of candidates) {
      const candidateText = [candidate.title, candidate.description, candidate.terms].filter(Boolean).join(' ');
      // 0 is the "no verified value" sentinel on the live Offer table (both
      // original_price and offer_price — see ai-offers-from-online.service.ts)
      // — never a real ₹0. Feeding a raw 0 into classifyMechanic would let
      // FLAT_PRICE fire on a real-original/no-verified-offer-price offer
      // (originalPrice > 0 sentinel), misclassifying a BOGO/percentage/etc.
      // offer as a flat price instead of reading its actual text mechanic.
      const candidateMechanic = classifyMechanic(
        candidateText,
        candidate.original_price || null,
        candidate.offer_price || null,
      );
      const jaccard = titleJaccard(input.offerTitle, candidate.title);
      const mechanicMatch = mechanicsEqual(incomingMechanic, candidateMechanic);

      let confidence: DuplicateConfidence | null = null;
      if (mechanicMatch && jaccard >= 0.5) confidence = 'HIGH';
      else if (mechanicMatch && jaccard >= 0.2) confidence = 'MEDIUM';
      else if (!mechanicMatch && jaccard >= 0.6) confidence = 'MEDIUM';

      if (!confidence) continue;

      const score = confidence === 'HIGH' ? 0.7 + 0.3 * jaccard : 0.4 + 0.3 * jaccard;
      const reasons = ['same_business'];
      if (mechanicMatch) reasons.push(`same_mechanic:${incomingMechanic.type}`);
      reasons.push(`title_similarity:${jaccard.toFixed(2)}`);

      if (!best || score > (best.score ?? 0)) {
        best = { confidence, duplicateOfferId: candidate.id, score, reasons };
      }
    }

    return best;
  }
}
