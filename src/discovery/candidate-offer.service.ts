import { Injectable, Logger } from '@nestjs/common';
import {
  Business,
  BusinessStatus,
  Offer,
  OfferStatus,
  OfferType,
  Source,
  VerificationStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExtractedFields } from './content-extraction.service';

const CANDIDATE_VALIDITY_DAYS = 30;
// No category-classification logic exists yet (Module 9 v1, deterministic
// extraction only) — every candidate defaults here and the admin corrects
// it during review. Matches the 12 real category ids in
// offer.controller.ts's OFFER_CATEGORIES.
const DEFAULT_CATEGORY = 'shopping';

export interface CandidateResult {
  business: Business;
  offer: Offer;
  warnings: string[];
}

// Module 9 Phase 3 — turns a successful extraction into a real, reviewable
// candidate: an UNCLAIMED Business (no owner yet — Phase 4 adds the claim
// flow) and a DRAFT Offer with review_required=true. DRAFT status alone
// already keeps it out of every customer-facing query (offer.service.ts's
// listOffers/getDetails both gate on status===ACTIVE) — review_required is
// the field the review queue itself filters on, not a second visibility
// gate. Nothing here ever sets status to ACTIVE; only ReviewQueueService's
// approve() does that, following explicit admin action.
@Injectable()
export class CandidateOfferService {
  private readonly logger = new Logger(CandidateOfferService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createCandidate(params: {
    sourceUrl: string;
    fields: ExtractedFields;
    confidence: number;
  }): Promise<CandidateResult> {
    const { sourceUrl, fields, confidence } = params;

    const title = fields.title ?? 'Untitled Imported Offer';
    const description = fields.description ?? 'No description available.';
    const price = fields.price ?? 0;

    const warnings: string[] = [];
    if (!fields.title) warnings.push('No title detected — using a placeholder');
    if (!fields.description) warnings.push('No description detected');
    if (fields.price === null)
      warnings.push('No price detected — defaulted to ₹0');
    if (!fields.image) warnings.push('No image detected');
    warnings.push(
      'Category not detected — defaulted to "Shopping", please verify',
    );

    const hostname = this.safeHostname(sourceUrl);
    const businessName = hostname
      ? `${hostname} (imported)`
      : 'Imported Business (unknown source)';

    const now = new Date();
    const endDate = new Date(
      now.getTime() + CANDIDATE_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
    );

    const { business, offer } = await this.prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          owner_name: 'Unclaimed',
          business_name: businessName,
          business_type: 'Retail',
          category: 'General',
          mobile: null,
          email: null,
          address: '',
          city: '',
          state: '',
          pincode: '',
          verification_status: VerificationStatus.PENDING,
          business_status: BusinessStatus.UNCLAIMED,
          source: Source.WEBSITE,
          created_by_ai: true,
        },
      });

      const offer = await tx.offer.create({
        data: {
          business_id: business.id,
          title,
          description,
          offer_type: OfferType.STANDARD,
          category: DEFAULT_CATEGORY,
          original_price: price,
          offer_price: price,
          required_people: 1,
          start_date: now,
          end_date: endDate,
          status: OfferStatus.DRAFT,
          source: Source.WEBSITE,
          confidence_score: confidence,
          imported_at: now,
          review_required: true,
          original_import_url: sourceUrl,
          original_import_source: 'WEBSITE',
          cover_image: fields.image,
        },
      });

      await tx.offerVersion.create({
        data: {
          offer_id: offer.id,
          version_no: 1,
          snapshot: offer,
          changed_by: null,
          change_type: 'AI_IMPORT',
        },
      });

      return { business, offer };
    });

    this.logger.log(
      `Created review candidate: business=${business.id} offer=${offer.id} confidence=${confidence}`,
    );
    return { business, offer, warnings };
  }

  private safeHostname(url: string): string | null {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }
}
