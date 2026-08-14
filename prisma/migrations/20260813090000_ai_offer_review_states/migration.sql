-- AI Offers From Online — real review states (2026-08-13). PRICE_REQUIRED
-- and CATEGORY_REQUIRED split out of the generic FAILED status: a missing
-- price or an unmapped category is an expected, admin-correctable review
-- state, not a processing bug. EXPIRED is a proxy based on this row's own
-- validity_end — Pairley has no crawler and cannot verify source-page
-- liveness. FAILED is reserved for genuine processing failures from here on.
ALTER TYPE "AiOfferFromOnlineStatus" ADD VALUE 'PRICE_REQUIRED';
ALTER TYPE "AiOfferFromOnlineStatus" ADD VALUE 'CATEGORY_REQUIRED';
ALTER TYPE "AiOfferFromOnlineStatus" ADD VALUE 'EXPIRED';

-- Raw, as-reported-by-the-Collector price signal — audit/informational
-- only, never read by publish() or any readiness check. Kept separate from
-- offer_price so an ambiguous/unverified source number is never mistaken
-- for the verified one.
ALTER TABLE "ai_offers_from_online" ADD COLUMN "source_price" DOUBLE PRECISION;
ALTER TABLE "ai_offers_from_online" ADD COLUMN "source_currency" TEXT DEFAULT 'INR';
