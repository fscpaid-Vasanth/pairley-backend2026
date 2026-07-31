-- Bulk Offer Import — the Diwali-launch replacement for the AI Discovery
-- Tool (removed in the prior migration's sibling commit). Offers are
-- authored externally (ChatGPT/manual curation), uploaded as a
-- spreadsheet, and published in bulk; a separate Bulk Image Upload step
-- matches image files to offers by a generated offer_code.
--
-- DOCUMENTATION ONLY, per this project's established convention — schema
-- is synced with `prisma db push` (no `_prisma_migrations` table in
-- production); this folder is a written record of what was applied, not
-- what actually ran the change.
--
-- Applied to production on 2026-07-31 across several `db push` calls as
-- the design was refined in place (see the four "one more schema gap"
-- corrections below) — this file is the final, consolidated shape.
--
-- Purely additive:
--   * Offer.offer_code is a new NOT NULL autoincrement column. Verified
--     empirically after applying, not just assumed from Postgres's
--     documented SERIAL behavior: all 16 existing offers received unique,
--     sequential, non-null values (1-16), zero rows altered.
--   * BulkImportBatch/BulkImportRow/BulkImportImage are new tables, so
--     nothing existing is touched by their creation.
--   * BulkImportStatus/BulkImportRowStatus/BulkImageStatus are new enums.
--
-- Four corrections made during implementation, before any production data
-- existed in the new tables (so no backfill/migration risk from these):
--   1. Business.pincode is required and non-nullable, but neither the
--      original CSV field list nor the initial row schema included it —
--      traced from the schema, not assumed. Added as its own validated,
--      required column (6-digit pattern) rather than defaulted blank.
--   2. BulkImportStatus initially conflated "create DRAFT offers" and
--      "publish" into one PUBLISHING state. Split into CREATING/CREATED
--      (offer-creation stage) and PUBLISHING/COMPLETED (the later,
--      separate DRAFT->ACTIVE action) to match the real two-stage
--      workflow — images attach to already-created DRAFT offers, before
--      anything goes live.
--   3. BulkImportRow.warnings added as its own column, separate from
--      errors — a row can be VALID with a warning (e.g. an unusually
--      steep discount) and still publish; conflating it with errors would
--      have made "valid but flagged" indistinguishable from "blocked".
--   4. BulkImportRow.normalized added to persist the validated, typed
--      row once (at validation time) rather than re-deriving it from
--      raw_data at draft-creation and publish time — so a row's outcome
--      can never silently diverge between what Preview showed the admin
--      and what actually got created/published.
--   5. BulkImportImage.slot made nullable — INVALID_FILE and
--      MISSING_OFFER outcomes genuinely have no resolved slot, unlike a
--      MAPPED or DUPLICATE image which always does.
--   6. BulkImportBatch.created_rows added alongside the pre-existing
--      published_rows, so CREATING-phase progress uses the same
--      increment-per-item pattern as every other stage, rather than
--      mixing an increment-based counter for one phase and a query-based
--      one for another.

CREATE TYPE "BulkImportStatus" AS ENUM (
  'QUEUED', 'VALIDATING', 'VALIDATED', 'CREATING', 'CREATED', 'PUBLISHING', 'COMPLETED', 'FAILED'
);

CREATE TYPE "BulkImportRowStatus" AS ENUM (
  'PENDING', 'VALID', 'INVALID', 'DUPLICATE', 'CREATED', 'PUBLISHED', 'FAILED'
);

CREATE TYPE "BulkImageStatus" AS ENUM (
  'PENDING', 'MAPPED', 'MISSING_OFFER', 'DUPLICATE', 'INVALID_FILE', 'UPLOADED', 'FAILED'
);

ALTER TABLE "offers"
  ADD COLUMN "offer_code" SERIAL NOT NULL;
ALTER TABLE "offers"
  ADD CONSTRAINT "offers_offer_code_key" UNIQUE ("offer_code");

CREATE TABLE "bulk_import_batches" (
  "id" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "file_url" TEXT NOT NULL,
  "uploaded_by" TEXT NOT NULL,
  "status" "BulkImportStatus" NOT NULL DEFAULT 'QUEUED',
  "total_rows" INTEGER NOT NULL DEFAULT 0,
  "valid_rows" INTEGER NOT NULL DEFAULT 0,
  "invalid_rows" INTEGER NOT NULL DEFAULT 0,
  "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
  "created_rows" INTEGER NOT NULL DEFAULT 0,
  "published_rows" INTEGER NOT NULL DEFAULT 0,
  "total_images" INTEGER NOT NULL DEFAULT 0,
  "mapped_images" INTEGER NOT NULL DEFAULT 0,
  "failed_images" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bulk_import_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bulk_import_rows" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "row_no" INTEGER NOT NULL,
  "raw_data" JSONB NOT NULL,
  "normalized" JSONB,
  "status" "BulkImportRowStatus" NOT NULL DEFAULT 'PENDING',
  "errors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "warnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "matched_business_id" TEXT,
  "created_offer_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bulk_import_rows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bulk_import_rows_batch_id_fkey" FOREIGN KEY ("batch_id")
    REFERENCES "bulk_import_batches"("id") ON DELETE CASCADE
);
CREATE INDEX "bulk_import_rows_batch_id_status_idx" ON "bulk_import_rows"("batch_id", "status");

CREATE TABLE "bulk_import_images" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "parsed_code" INTEGER,
  "slot" INTEGER,
  "matched_offer_id" TEXT,
  "status" "BulkImageStatus" NOT NULL DEFAULT 'PENDING',
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bulk_import_images_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bulk_import_images_batch_id_fkey" FOREIGN KEY ("batch_id")
    REFERENCES "bulk_import_batches"("id") ON DELETE CASCADE
);
CREATE INDEX "bulk_import_images_batch_id_status_idx" ON "bulk_import_images"("batch_id", "status");
