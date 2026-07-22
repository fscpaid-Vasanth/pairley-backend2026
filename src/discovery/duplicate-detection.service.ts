import { Injectable, Logger } from '@nestjs/common';
import { Business, BusinessStatus, Offer, OfferStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_CATEGORY } from './candidate-offer.service';

// Candidate pools are bounded regardless of how narrow category/status
// filtering turns out to be in practice — a hard cap keeps this deterministic
// and cheap even as import volume grows, per the Module 11 STEP 1
// performance note. Recency-ordered so the cap favors comparing against
// recent imports, the ones most likely to actually be duplicates of a
// just-created candidate.
const CANDIDATE_POOL_LIMIT = 200;

const OFFER_DUPLICATE_THRESHOLD = 0.55;
const BUSINESS_DUPLICATE_THRESHOLD = 0.5;

// Never compared against — these statuses mean the offer was explicitly
// dismissed by an admin, so flagging new imports against them as
// "duplicates" would be actively unhelpful (a rejected offer isn't a
// legitimate "original" to point at).
const EXCLUDED_OFFER_STATUSES: OfferStatus[] = [
  OfferStatus.REJECTED,
  OfferStatus.ARCHIVED,
];

export interface DuplicateMatch {
  id: string;
  score: number;
  reasons: string[];
}

// Deterministic, rule-based only — no fuzzy-matching library, no LLM, same
// discipline as every other Module 9/10/11 discovery service. Runs after
// CandidateOfferService has already created the Business/Offer rows;
// results are a *recommendation* only (Decision 4) — nothing here ever
// merges, rejects, or blocks anything. The admin always makes the final
// call in the review queue.
@Injectable()
export class DuplicateDetectionService {
  private readonly logger = new Logger(DuplicateDetectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Looks up and persists duplicate flags for a just-created candidate.
  // Failures here are logged and swallowed, never rethrown — duplicate
  // detection is an enhancement on top of a successful import, not a
  // correctness-critical step; a bug here must not fail the whole import.
  async detectAndFlag(offer: Offer, business: Business): Promise<void> {
    try {
      const offerMatch = await this.findOfferDuplicate(
        offer,
        business.business_name,
      );
      if (offerMatch) {
        await this.prisma.offer.update({
          where: { id: offer.id },
          data: {
            duplicate_of_offer_id: offerMatch.id,
            duplicate_score: offerMatch.score,
            duplicate_reasons: offerMatch.reasons,
          },
        });
        this.logger.log(
          `Offer ${offer.id} flagged as a possible duplicate of ${offerMatch.id} (score=${offerMatch.score})`,
        );
      }

      const businessMatch = await this.findBusinessDuplicate(business);
      if (businessMatch) {
        await this.prisma.business.update({
          where: { id: business.id },
          data: {
            duplicate_of_business_id: businessMatch.id,
            duplicate_score: businessMatch.score,
            duplicate_reasons: businessMatch.reasons,
          },
        });
        this.logger.log(
          `Business ${business.id} flagged as a possible duplicate of ${businessMatch.id} (score=${businessMatch.score})`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Duplicate detection failed for offer=${offer.id} business=${business.id} — continuing without a flag`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  async findOfferDuplicate(
    offer: Offer,
    businessName: string,
  ): Promise<DuplicateMatch | null> {
    const pool = await this.prisma.offer.findMany({
      where: {
        id: { not: offer.id },
        status: { notIn: EXCLUDED_OFFER_STATUSES },
        category: offer.category,
      },
      include: { business: { select: { business_name: true } } },
      orderBy: { created_at: 'desc' },
      take: CANDIDATE_POOL_LIMIT,
    });

    let best: DuplicateMatch | null = null;
    for (const candidate of pool) {
      const { score, reasons } = this.scoreOfferPair(
        offer,
        businessName,
        candidate,
      );
      if (score >= OFFER_DUPLICATE_THRESHOLD && (!best || score > best.score)) {
        best = { id: candidate.id, score, reasons };
      }
    }
    return best;
  }

  async findBusinessDuplicate(
    business: Business,
  ): Promise<DuplicateMatch | null> {
    const pool = await this.prisma.business.findMany({
      where: {
        id: { not: business.id },
        business_status: BusinessStatus.UNCLAIMED,
      },
      orderBy: { created_at: 'desc' },
      take: CANDIDATE_POOL_LIMIT,
    });

    let best: DuplicateMatch | null = null;
    for (const candidate of pool) {
      const { score, reasons } = this.scoreBusinessPair(business, candidate);
      if (
        score >= BUSINESS_DUPLICATE_THRESHOLD &&
        (!best || score > best.score)
      ) {
        best = { id: candidate.id, score, reasons };
      }
    }
    return best;
  }

  // Weights sum to 1.0. Title carries the most weight since it's the
  // strongest single signal for "is this the same offer," but never enough
  // alone to cross the 0.55 threshold (max 0.4) — at least one corroborating
  // signal (type/price/category/merchant) is always required too.
  private scoreOfferPair(
    a: Offer,
    aBusinessName: string,
    b: Offer & { business: { business_name: string } | null },
  ): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    const titleSim = this.tokenOverlapScore(a.title, b.title);
    if (titleSim > 0) {
      score += titleSim * 0.4;
      if (titleSim >= 0.95) {
        reasons.push('Title is an exact or near-exact match');
      } else if (titleSim >= 0.5) {
        reasons.push(
          `Title is closely similar (${Math.round(titleSim * 100)}% word overlap)`,
        );
      }
    }

    if (a.offer_type === b.offer_type) {
      score += 0.15;
      reasons.push(`Same offer type (${a.offer_type})`);
    }

    const priceSim = this.priceProximityScore(a.offer_price, b.offer_price);
    if (priceSim > 0) {
      score += priceSim * 0.15;
      if (priceSim >= 0.9) reasons.push('Price matches (within 10%)');
    }

    // Not a real signal today: category classification doesn't exist yet
    // (Phase 3+), so every AI-imported candidate shares the same
    // DEFAULT_CATEGORY — awarding credit for that trivial match would
    // inflate every single comparison by a constant amount regardless of
    // actual similarity. Only counts once category is genuinely
    // differentiated (i.e. not the shared default).
    if (a.category === b.category && a.category !== DEFAULT_CATEGORY) {
      score += 0.1;
      reasons.push('Same category');
    }

    const bBusinessName = b.business?.business_name ?? '';
    // Not a real signal when both sides are still a generic per-source-type
    // placeholder (e.g. "Poster Import", "PDF Import") — every non-WEBSITE
    // import gets exactly this label (candidate-offer.service.ts's
    // deriveBusinessName), so crediting a match here would fire between
    // every pair of poster/PDF imports regardless of the real merchant.
    // Same reasoning as the DEFAULT_CATEGORY exclusion above; only counts
    // once at least one side has a real, source-derived name (e.g. a
    // WEBSITE import's hostname).
    if (
      !this.isGenericImportLabel(aBusinessName) ||
      !this.isGenericImportLabel(bBusinessName)
    ) {
      const merchantSim = this.tokenOverlapScore(
        this.stripImportSuffix(aBusinessName),
        this.stripImportSuffix(bBusinessName),
      );
      if (merchantSim > 0) {
        score += merchantSim * 0.2;
        if (merchantSim >= 0.5) reasons.push('Likely the same merchant');
      }
    }

    score = Math.round(score * 100) / 100;
    return { score, reasons };
  }

  private scoreBusinessPair(
    a: Business,
    b: Business,
  ): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    // Not a real signal when both names are still the generic
    // per-source-type placeholder — see the identical exclusion in
    // scoreOfferPair's merchant-similarity check for the full reasoning.
    // Without this, business-duplicate detection would fire between every
    // pair of poster/PDF-sourced businesses regardless of the real
    // merchant, since they all start out with an identical generic label.
    if (
      !this.isGenericImportLabel(a.business_name) ||
      !this.isGenericImportLabel(b.business_name)
    ) {
      const nameSim = this.tokenOverlapScore(
        this.stripImportSuffix(a.business_name),
        this.stripImportSuffix(b.business_name),
      );
      if (nameSim > 0) {
        score += nameSim * 0.6;
        if (nameSim >= 0.95) {
          reasons.push('Business name is an exact or near-exact match');
        } else if (nameSim >= 0.5) {
          reasons.push(
            `Business name is closely similar (${Math.round(nameSim * 100)}% word overlap)`,
          );
        }
      }
    }

    // Effectively inert today, same reasoning as the geo check below:
    // AI-imported (UNCLAIMED) businesses always have mobile=null
    // (candidate-offer.service.ts never sets one), and Business.mobile is
    // DB-unique, so two UNCLAIMED rows can never legitimately share a
    // non-null value anyway. Kept for forward-compatibility — a richer
    // future import source (e.g. a business profile with a public contact
    // number) would make this a strong, near-unique signal immediately.
    if (a.mobile && b.mobile && a.mobile === b.mobile) {
      score += 0.3;
      reasons.push('Same mobile number');
    }

    // Future-ready: AI-imported businesses never have geo coordinates today
    // (candidate-offer.service.ts writes address/city/state/pincode as
    // empty strings and never sets geo_lat/geo_lng), so this dimension is
    // inert in practice until that changes — kept here so location becomes
    // a real signal the moment it's populated, with no further code changes.
    if (
      a.geo_lat !== null &&
      a.geo_lng !== null &&
      b.geo_lat !== null &&
      b.geo_lng !== null
    ) {
      const distance = this.approxDistanceMeters(
        a.geo_lat,
        a.geo_lng,
        b.geo_lat,
        b.geo_lng,
      );
      if (distance < 100) {
        score += 0.1;
        reasons.push('Same location');
      }
    }

    score = Math.round(score * 100) / 100;
    return { score, reasons };
  }

  private priceProximityScore(a: number, b: number): number {
    if (!a || !b) return 0;
    const diff = Math.abs(a - b) / Math.max(a, b);
    if (diff <= 0.1) return 1;
    if (diff >= 0.5) return 0;
    return 1 - (diff - 0.1) / 0.4;
  }

  // Very rough equirectangular approximation — more than adequate at the
  // <100m threshold this is used for; not meant for general-purpose
  // distance calculation.
  private approxDistanceMeters(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
  ): number {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const meanLat = ((lat1 + lat2) / 2) * (Math.PI / 180);
    const x = dLng * Math.cos(meanLat);
    return Math.sqrt(x * x + dLat * dLat) * R;
  }

  private stripImportSuffix(name: string): string {
    return name.replace(/\s*\(imported\)\s*$/i, '');
  }

  // Matches candidate-offer.service.ts's deriveBusinessName() fallback
  // format ("PDF Import (imported)", "Poster Import (imported)", and the
  // same pattern for any future non-WEBSITE Source) — a name that carries
  // zero real merchant-identifying information, just the import source
  // type. WEBSITE imports never match this (they get a real hostname).
  private isGenericImportLabel(name: string): boolean {
    return /^\w+\s+import$/i.test(this.stripImportSuffix(name).trim());
  }

  private normalizeText(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Jaccard-style token overlap: |shared| / |union|. Exact match after
  // normalization short-circuits to 1. No fuzzy/edit-distance library —
  // deliberately simple and deterministic, same discipline as the rest of
  // Module 9/10/11's extraction/normalization services.
  private tokenOverlapScore(a: string, b: string): number {
    const normA = this.normalizeText(a || '');
    const normB = this.normalizeText(b || '');
    if (!normA || !normB) return 0;
    if (normA === normB) return 1;

    const tokensA = new Set(normA.split(' ').filter(Boolean));
    const tokensB = new Set(normB.split(' ').filter(Boolean));
    const union = new Set([...tokensA, ...tokensB]);
    let shared = 0;
    for (const token of tokensA) {
      if (tokensB.has(token)) shared += 1;
    }
    return union.size === 0 ? 0 : shared / union.size;
  }
}
