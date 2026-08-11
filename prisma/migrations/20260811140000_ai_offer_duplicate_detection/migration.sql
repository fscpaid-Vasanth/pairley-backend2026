-- AI offer duplicate detection (2026-08-11): publish() now auto-resolves an
-- UNCLAIMED merchant instead of hard-blocking on "no business matched", and
-- runs a duplicate check first. A HIGH-confidence match suppresses the
-- publish and is recorded here for auditability; a MEDIUM-confidence match
-- still publishes and is recorded on the real Offer's own existing
-- duplicate_* fields instead (no new columns needed there).
ALTER TYPE "AiOfferFromOnlineStatus" ADD VALUE 'DUPLICATE_SUPPRESSED';

ALTER TABLE "ai_offers_from_online" ADD COLUMN "duplicate_of_offer_id" TEXT;
ALTER TABLE "ai_offers_from_online" ADD COLUMN "duplicate_score" DOUBLE PRECISION;
ALTER TABLE "ai_offers_from_online" ADD COLUMN "duplicate_reasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
