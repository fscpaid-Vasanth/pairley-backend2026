-- Module 4: Customer Discovery — Phase 2 (Backend geo/radius/category/expiry)
-- Generated offline via `prisma migrate diff` (read-only, no datasource
-- connection made). Purely additive: one index. No drops, no data loss risk.
-- Not yet applied to any database.

-- CreateIndex
CREATE INDEX "offers_geo_lat_geo_lng_idx" ON "offers"("geo_lat", "geo_lng");
