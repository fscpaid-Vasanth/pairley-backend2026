-- Module 2: Merchant Business Profile
-- Generated offline via `prisma migrate diff` (read-only, no datasource connection
-- made) comparing the schema at commit ed658d1 (pre-Module-2) to the current
-- Module 2 schema. Not yet applied to any database.
--
-- Purely additive: 12 new nullable/defaulted columns + 1 new enum. No drops,
-- no type narrowing, no data loss risk. Same backward-compatible pattern as
-- Module 1's migration — safe to apply before or after the code deploys.

-- CreateEnum
CREATE TYPE "LeadAcceptanceMode" AS ENUM ('MANUAL', 'AUTOMATIC');

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "cover_image" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "facebook" TEXT,
ADD COLUMN     "gallery_images" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "geo_lat" DOUBLE PRECISION,
ADD COLUMN     "geo_lng" DOUBLE PRECISION,
ADD COLUMN     "instagram" TEXT,
ADD COLUMN     "lead_acceptance_mode" "LeadAcceptanceMode" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "logo" TEXT,
ADD COLUMN     "store_timing" JSONB,
ADD COLUMN     "support_number" TEXT,
ADD COLUMN     "website" TEXT,
ADD COLUMN     "whatsapp" TEXT;
