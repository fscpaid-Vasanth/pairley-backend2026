-- Module 14 Phase 3C — merchant banner branding preference.
--
-- DOCUMENTATION ONLY. This project syncs schema with `prisma db push`
-- (there is no `_prisma_migrations` table in production); these folders are
-- a written record of what was applied, matching the convention established
-- in Modules 9-13. Applied to production on 2026-07-30 via `prisma db push`
-- with no `--accept-data-loss` flag required.
--
-- Purely additive:
--   * banner_branding_mode is NOT NULL with a PAIRLEY default, so all 17
--     existing businesses kept Pairley branding (verified after applying:
--     17/17 defaulted, 0 rows altered).
--   * brand_color is nullable, so no existing row needed a value.
--
-- Why PAIRLEY is the default rather than MERCHANT: a merchant who has not
-- explicitly chosen otherwise has not asked for their branding to lead on a
-- Pairley-published banner. MERCHANT is additionally refused at render time
-- for any business that is not CLAIMED — see bannerBranding.ts's
-- resolveBranding(), which mirrors the rule that already withholds an
-- unclaimed merchant's logo.

CREATE TYPE "BannerBrandingMode" AS ENUM ('PAIRLEY', 'MERCHANT');

ALTER TABLE "businesses"
  ADD COLUMN "banner_branding_mode" "BannerBrandingMode" NOT NULL DEFAULT 'PAIRLEY',
  ADD COLUMN "brand_color" TEXT;
