-- Launch-readiness scalability finding: neither status nor business_id was
-- indexed on offers. Invisible at today's ~25-row catalog, but /offers/list
-- (filtered to status=ACTIVE by default) is the single most-hit query in
-- the app and was heading for a full table scan at the 10,000-offer launch
-- target.
CREATE INDEX "offers_status_idx" ON "offers"("status");
CREATE INDEX "offers_business_id_status_idx" ON "offers"("business_id", "status");
