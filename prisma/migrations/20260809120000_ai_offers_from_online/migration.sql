-- AI Offers From Online (2026-08-09) — additive only. No existing table,
-- column, index, or enum is touched. NOT applied to any database by this
-- change — written for review; apply via `prisma migrate deploy` once the
-- historical migrations have been baselined (see the deployment report).
--
-- Supersedes the earlier, never-applied `20260809120000_ai_offer_review`
-- migration, which was removed rather than layered on top: it had never run
-- against any database, so there is nothing to alter or roll forward from.
--
-- offer_price and banner_image_url are deliberately NOT NULL. The Collector
-- cannot generate a banner without a resolved price, and cannot export
-- without an approved banner — so an offer missing either can never reach
-- this table. The database enforces the same rule the export gate does.

-- CreateEnum
CREATE TYPE "AiOfferFromOnlineStatus" AS ENUM ('PENDING_ADMIN_REVIEW', 'MERCHANT_MATCHED', 'READY_TO_PUBLISH', 'PUBLISHED', 'FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "ai_offers_from_online" (
    "id" TEXT NOT NULL,
    "collector_offer_id" TEXT NOT NULL,
    "status" "AiOfferFromOnlineStatus" NOT NULL DEFAULT 'PENDING_ADMIN_REVIEW',
    "matched_business_id" TEXT,
    "created_business_id" TEXT,
    "created_offer_id" TEXT,
    "merchant_name" TEXT NOT NULL,
    "mobile" TEXT,
    "whatsapp" TEXT,
    "category" TEXT,
    "address" TEXT NOT NULL,
    "city" TEXT,
    "offer_title" TEXT NOT NULL,
    "description" TEXT,
    "original_price" DOUBLE PRECISION,
    "offer_price" DOUBLE PRECISION NOT NULL,
    "validity_start" TIMESTAMP(3),
    "validity_end" TIMESTAMP(3),
    "terms" TEXT,
    "banner_image_url" TEXT NOT NULL,
    "source_url" TEXT,
    "source_type" TEXT,
    "field_provenance" JSONB,
    "rejection_reason" TEXT,
    "failure_reason" TEXT,
    "exported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_offers_from_online_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_offers_from_online_collector_offer_id_key" ON "ai_offers_from_online"("collector_offer_id");

-- CreateIndex
CREATE INDEX "ai_offers_from_online_status_idx" ON "ai_offers_from_online"("status");
