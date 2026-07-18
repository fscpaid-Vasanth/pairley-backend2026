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

-- One-time backfill: every business row that already exists was created through
-- the self-service registration flow (Group B / AI import doesn't exist yet), so
-- all of them are real, owned accounts — never UNCLAIMED. Without this, the
-- default above would incorrectly mark all pre-existing merchants as unclaimed.
UPDATE "businesses" SET "business_status" = 'CLAIMED' WHERE "business_status" = 'UNCLAIMED';
