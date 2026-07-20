-- Module 5: Lead Management — Phase 1 (Database)
-- Hand-reviewed after generating an offline `prisma migrate diff` (read-only,
-- no datasource connection made) — the auto-generated script added
-- `updated_at TIMESTAMP(3) NOT NULL` with no default, which would fail
-- against the 7 existing lead rows in production. Fixed below with an
-- explicit default. The status column swap is safe: every existing lead's
-- status is the literal string 'Interested', which maps 1:1 to the new
-- enum's default value 'NEW'.
--
-- At deployment time, `prisma db push` (the actual apply mechanism this
-- project uses — this file is documentation/review only, db push
-- regenerates its own DDL from schema.prisma) independently caught the
-- same issue and refused to run: `@updatedAt` alone has no SQL-level
-- DEFAULT. Fixed in schema.prisma with `@default(now()) @updatedAt`
-- before re-running db push. No data was touched by the aborted attempt.

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'CONVERTED', 'NOT_INTERESTED');

-- AlterTable: updated_at (existing rows backfilled via DEFAULT)
ALTER TABLE "leads" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable: status String -> LeadStatus enum (existing 'Interested' rows
-- become NEW via the new column's default, then the old column is dropped)
ALTER TABLE "leads" ADD COLUMN "status_new" "LeadStatus" NOT NULL DEFAULT 'NEW';
ALTER TABLE "leads" DROP COLUMN "status";
ALTER TABLE "leads" RENAME COLUMN "status_new" TO "status";

-- CreateIndex
CREATE INDEX "leads_shop_id_status_created_at_idx" ON "leads"("shop_id", "status", "created_at");
