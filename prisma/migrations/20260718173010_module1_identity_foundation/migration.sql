-- Module 1: Identity & Business Onboarding Foundation
-- Generated offline via `prisma migrate diff` (read-only, no datasource connection
-- made) comparing the schema at commit 46b48b1 (pre-Module-1) to the schema at
-- commit ad7754e (Module 1). Not yet applied to any database.

-- CreateEnum
CREATE TYPE "BusinessStatus" AS ENUM ('UNCLAIMED', 'CLAIMED', 'VERIFIED', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "Source" AS ENUM ('MANUAL', 'WEBSITE', 'INSTAGRAM', 'FACEBOOK', 'GOOGLE', 'PDF', 'POSTER', 'ADMIN');

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "business_status" "BusinessStatus" NOT NULL DEFAULT 'UNCLAIMED',
ADD COLUMN     "claimed_at" TIMESTAMP(3),
ADD COLUMN     "claimed_by" TEXT,
ADD COLUMN     "created_by_ai" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "source" "Source" NOT NULL DEFAULT 'MANUAL',
ALTER COLUMN "email" DROP NOT NULL;

-- AlterTable
ALTER TABLE "offers" ADD COLUMN     "source" "Source" NOT NULL DEFAULT 'MANUAL';

-- One-time backfill: scoped to created_by_ai = false so any future AI-imported
-- business (Group B) is never touched by this statement, even if re-run later.
UPDATE "businesses"
SET
    business_status = 'CLAIMED',
    source = 'MANUAL'
WHERE
    created_by_ai = false
    AND business_status = 'UNCLAIMED';
