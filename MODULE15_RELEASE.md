# Module 15 Release — Bulk Offer Import & Lead-Capture Marketplace

**Tag:** `pairley-module15-bulk-import-complete` (backend `eac0af1`, frontend `ff03825`)
**Released:** 2026-07-31

Pairley's Diwali-launch pivot: offers are now authored externally (ChatGPT / manual curation) and bulk-uploaded by an admin, rather than discovered by crawling a merchant's own listings. Customer interest is captured as a lead and handed to Pairley's team to follow up — merchant/customer contact is not brokered automatically. Full technical detail lives in [BULK_OFFER_IMPORT.md](./BULK_OFFER_IMPORT.md); this document is the release-level summary.

---

## Bulk Offer Import

Admin uploads a CSV/XLSX sheet (`POST /admin/bulk-import`) — Merchant Name, Category, Offer Title/Description/Type, Original/Offer Price, Minimum Participants, Valid From/Until, Contact Number, WhatsApp, Email, Website, Address, City/State/Pincode, Latitude/Longitude, Terms. Each row is validated (required fields, price sanity, ≥70%-discount warning, phone/date/geo format, duplicate detection against both the same upload and existing businesses) before anything is created. Valid rows become `DRAFT` offers, each assigned a short `offer_code` (`OFF000123`) used to match images in the next step. Nothing is customer-visible until an explicit Publish action.

## Bulk Image Upload

A separate step (`POST /admin/bulk-import/:id/images` or `.../images/zip`) uploads JPG/PNG/WEBP files — individually or as a ZIP — matched to their offer purely by the `offer_code` embedded in the filename (`OFF000123.jpg` → hero, `OFF000123_1.jpg` → gallery position 1, etc.). Matching is scoped to the uploading batch's own offers, so one admin's upload can never paint another's. An offer with no matched image still publishes, falling back to a Pairley placeholder.

## Lead Capture Workflow

The customer journey is now a single, short path: **Browse → Show Interest → Log in / Sign up → Interest Recorded → Thank You.** There is no in-app chat and no automatic merchant-contact reveal — the confirmation is exactly "Thank you for your interest! Your request has been recorded successfully. Our team or the merchant will contact you shortly." with no phone number, WhatsApp button, address, or navigation link anywhere on the page.

This is governed by a platform-wide `LEAD_FOLLOWUP_MODE` environment variable, not a hardcoded removal:

- **`ADMIN_MANAGED`** (default, active for this launch) — contact is never handed to a customer through the offer-details endpoint. Pairley captures the lead; the admin or merchant follows up manually, off-platform.
- **`MERCHANT_MANAGED`** (built, tested, disabled by default) — restores direct reveal: a `CLAIMED` business's contact unlocks for a signed-in customer once they've expressed interest in that specific offer.

Switching modes later is a one-line environment-variable change, not a redesign — the entitlement logic and the frontend's contact-display path already exist, are already tested, and are simply dormant under the default.

## UNCLAIMED Merchant Model

Every bulk-imported business is created with `business_status: UNCLAIMED` — identical in every respect to a business that was never touched by any admin tooling. It appears in search and offers normally, but its dashboard, editing, analytics, subscription, and branding stay locked until the real owner claims it through the existing OTP-based claim flow. There is no separate "admin-curated" tier of merchant; bulk-imported and organically-discovered unclaimed businesses are treated identically by every downstream system.

## Admin Lead Management

A new **Leads** tab in the Admin Management Console (`GET /admin/leads`) lists every customer who has shown interest in any offer, platform-wide:

| Customer | Mobile | Offer | Merchant | Date & Time | Source | Follow-up Status |
|---|---|---|---|---|---|---|

- **Source** — `Website` or `Mobile App`, detected automatically (Capacitor native-platform check) at the moment the customer submits interest.
- **Follow-up Status** — filterable by New / Contacted / Converted / Not Interested, reusing the same status field Module 13's merchant lead flow already uses.

## Removed: AI Discovery Architecture

The crawling/OCR/AI-extraction pipeline (Modules 9–11, 14) is fully removed: URL fetching, robots.txt checks, PDF/text extraction, OCR, content normalization, duplicate/confidence scoring, and the review-queue admin UI. No AI processing, website crawling, or OCR remains anywhere in the offer-creation path. `sharp`, `qrcode`, and `tesseract.js` were dropped as dependencies; `exceljs`, `csv-parse`, and `unzipper` were added for the new import path.

## Removed: Banner Engine

Automated banner/poster generation (hero-image ranking, banner rendering, banner templates, cost-split banner layouts, the Banner Studio admin modal) is fully removed. Offer images now come directly from the Bulk Image Upload step or a merchant's own upload — nothing is generated.

## Removed: Customer Chat

The in-app deal-coordination chat that previously followed "Show Interest" is removed from this flow. It's replaced by the lead-capture confirmation described above; Pairley or the merchant reaches out directly, outside the app.

## Known Future Enhancements

- `MERCHANT_MANAGED` follow-up mode is built and unit-tested but has not had a live end-to-end verification pass — worth doing before ever enabling it in production.
- A real 1,000+ row / 1,000+ image batch hasn't been exercised yet to confirm the pipeline's stated scale targets (verified so far at small n).
- `LeadStatus` values (`NEW`/`CONTACTED`/`CONVERTED`/`NOT_INTERESTED`) were kept as-is rather than relabeled to New/Contacted/Interested/Converted/Closed, since the enum is shared with Module 13's merchant-facing lead flow — a platform-wide rename is a separate piece of work.
- The AWS S3 access key (`pairley-backend` IAM user) is under AWS's `AWSCompromisedKeyQuarantineV3` policy (`s3:ListBucket` denied; writes still succeed). Rotating this key remains an open action item — it should happen before any bucket-wide audit or cleanup of orphaned test objects is possible.
- Two unrelated, pre-existing bodies of uncommitted work were found in the frontend working tree during this release (marketing-page animation/NaN-safety fixes, and a Firebase Storage migration in progress — `storage.rules`, `MIGRATION_PLAN.md`, `ROADMAP_AUDIT.md`) and were deliberately left out of this commit/tag as out of scope. They remain on disk, uncommitted, for a separate review.
