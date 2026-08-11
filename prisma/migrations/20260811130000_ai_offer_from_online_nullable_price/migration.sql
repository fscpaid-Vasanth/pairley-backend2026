-- offer_price on ai_offers_from_online becomes nullable (2026-08-11): the
-- Collector's readiness gate now allows an offer to export with no numeric
-- price when it carries a verified non-price promotional mechanic instead
-- (stated discount percentage, BOGO, BOGT, or an explicit free-benefit
-- offer). Never a guess, never a fabricated 0 - null is the honest value.
-- Existing rows are untouched: every row already has a real, non-null price.
ALTER TABLE "ai_offers_from_online" ALTER COLUMN "offer_price" DROP NOT NULL;
