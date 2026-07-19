-- Module 3: Offer Management — Section 1 (Database)
-- Generated offline via `prisma migrate diff` (read-only, no datasource
-- connection made). Purely additive: 2 enum extensions, 12 new nullable/
-- defaulted columns on "offers", 1 new table ("offer_versions"). No drops,
-- no type narrowing, no data loss risk. Not yet applied to any database.

-- AlterEnum
ALTER TYPE "OfferType" ADD VALUE 'STANDARD';
ALTER TYPE "OfferType" ADD VALUE 'BUY_X_GET_Y';
ALTER TYPE "OfferType" ADD VALUE 'FLAT_DISCOUNT';
ALTER TYPE "OfferType" ADD VALUE 'PERCENTAGE_DISCOUNT';
ALTER TYPE "OfferType" ADD VALUE 'CASHBACK';
ALTER TYPE "OfferType" ADD VALUE 'COMBO';
ALTER TYPE "OfferType" ADD VALUE 'SEASONAL';
ALTER TYPE "OfferType" ADD VALUE 'FESTIVAL';
ALTER TYPE "OfferType" ADD VALUE 'FLASH_DEAL';
ALTER TYPE "OfferType" ADD VALUE 'LIMITED_QUANTITY';
ALTER TYPE "OfferType" ADD VALUE 'LIMITED_TIME';

-- AlterEnum
ALTER TYPE "OfferStatus" ADD VALUE 'PAUSED';
ALTER TYPE "OfferStatus" ADD VALUE 'ARCHIVED';

-- AlterTable
ALTER TABLE "offers" ADD COLUMN     "confidence_score" DOUBLE PRECISION,
ADD COLUMN     "cover_image" TEXT,
ADD COLUMN     "gallery_images" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "generated_offer_card" TEXT,
ADD COLUMN     "geo_lat" DOUBLE PRECISION,
ADD COLUMN     "geo_lng" DOUBLE PRECISION,
ADD COLUMN     "imported_at" TIMESTAMP(3),
ADD COLUMN     "is_pairley_exclusive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "merchant_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "original_import_source" TEXT,
ADD COLUMN     "original_import_url" TEXT,
ADD COLUMN     "original_poster" TEXT,
ADD COLUMN     "review_required" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "offer_versions" (
    "id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changed_by" TEXT,
    "change_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_versions_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "offer_versions" ADD CONSTRAINT "offer_versions_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One-time backfill (run once, after this migration is applied): copy legacy
-- media fields into the new Module 3 media model for existing offers.
UPDATE "offers" SET
    "cover_image" = "offer_image",
    "gallery_images" = "facility_images"
WHERE "cover_image" IS NULL;
