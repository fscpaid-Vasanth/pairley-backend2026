-- Module 6: Customer Profile & Saved Offers — Phase 2 (Database)
-- Generated offline via `prisma migrate diff` (read-only, no datasource
-- connection made). Purely additive: 3 new boolean columns on "customers",
-- each with a DEFAULT so existing rows backfill safely. No drops, no type
-- changes, no data loss risk. Not yet applied to any database.

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "notify_email" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notify_matching" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notify_push" BOOLEAN NOT NULL DEFAULT true;
