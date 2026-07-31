# Bulk Offer Import & Bulk Image Upload

**Status: implemented and verified end-to-end against production infrastructure. Released as `pairley-module15-bulk-import-complete`.** Replaces the AI Discovery Tool (Modules 9-11, 14 — removed in a separate commit) for the Diwali launch. No AI processing, no website crawling, no OCR, no banner generation anywhere in this path.

```
ChatGPT → Generate Offers → Export Excel → Bulk Offer Import → Generate Offer IDs
   → Bulk Image Upload → Automatic Image Mapping → Preview → Publish → Customers Browse
```

---

## 0. Lead-generation revision (2026-07-31)

Two decisions from an earlier round were explicitly reversed once the product direction sharpened further: Pairley is a **lead-capture marketplace**, not a contact broker. It publishes offers, captures interest, and hands qualified leads to the admin — merchant/customer coordination happens manually, outside the platform, for now.

- **No merchant status for bulk-imported businesses.** `ADMIN_CURATED` (added in the previous round) is retired — every bulk-imported business is `UNCLAIMED`, identical to any other undiscovered business, until its real owner claims it through the existing OTP flow. `BusinessStatus.ADMIN_CURATED` stays in the Postgres enum (harmless, inert, matching this project's "deprecate, don't drop" precedent from the AI Discovery removal) but nothing produces or reads it anymore.
- **No contact reveal, ever, for a customer.** `resolveContactAccess()` in `offerVisibility.ts` no longer depends on business status or expressed interest at all — it answers exactly one question: is this caller the business's own owner or a Pairley admin. Everyone else gets `SIGN_UP_REQUIRED` (anonymous) or `NOT_SHARED` (signed in). This is a genuine simplification, not just a policy tightening: the function dropped from 3 parameters and 5 branches to 1 parameter and 3 branches. It also retired the interest-gated reveal (`SHOW_INTEREST_REQUIRED`) that the previous round added — before this, the intent was "reveal contact once the customer asks"; now no path reveals it at all.
- **Customer flow simplified to a single terminus.** `InterestButton.jsx`'s post-interest card no longer shows a contact block (or a chat link, which it had already replaced) — it shows "Thank you for your interest! Your request has been recorded successfully. Our team or the merchant will contact you shortly." and nothing else. `merchantContact.js` correspondingly dropped to a single concern: whether the business has a published website to link (always public, unrelated to the contact-reveal policy either version of it had).
- **New: admin lead management dashboard.** `GET /admin/leads` (`DashboardService.listLeads`) lists every customer who has shown interest in any offer, platform-wide — Customer Name, Mobile, Offer, Merchant, Date & Time, Status — reusing the `Lead` model's existing denormalized fields, no schema change. Frontend: `LeadManagementPanel.jsx`, a new "Leads" admin tab.

**Scope call, stated plainly:** the instruction that motivated this ("No phone number. No WhatsApp. No address. No navigation. No chat.") was framed platform-wide, not scoped to bulk-imported offers specifically — and `InterestButton.jsx`'s standard flow is one shared component serving every offer regardless of source, so there was no way to retire contact-reveal for bulk-imported/`UNCLAIMED` merchants alone without adding a business-status branch back into a flow that had just been simplified. This round therefore retired customer-facing contact reveal for **every** offer, not just bulk-imported ones. Flagged here in case that reads as broader than intended for any pre-existing, genuinely `CLAIMED` merchant.

**Verification for this round:** the wiring between `offer.service.ts` and `offerVisibility.ts` was already proven correct end-to-end against live production infrastructure in the previous round (§7 below) — only the decision logic inside `resolveContactAccess()` changed, and that function is now covered by a rewritten, fully passing unit suite (`offerVisibility.spec.ts`, every viewer type). A second live-server pass was judged to have limited incremental value given the wiring itself is unchanged; happy to run one if wanted.

---

## 0b. Lead-generation revision, round 2 — configurable follow-up mode (2026-07-31)

The product owner's next instruction was explicit: *"I do not want to permanently remove the contact reveal capability from the platform. Instead, make it configurable."* This round does not change the Diwali-launch behavior in §0 above — it makes that behavior one of two selectable modes, set platform-wide via a single environment variable, so switching later is a config change, not a redesign.

- **`LEAD_FOLLOWUP_MODE` env var** — `resolveLeadFollowupMode()` in `offerVisibility.ts` reads it (via the caller, `offer.service.ts`'s `ConfigService`, keeping the policy function itself still pure/testable) and resolves to one of:
  - **`ADMIN_MANAGED`** (default, and the only mode active for the Diwali launch — unset or any unrecognized value degrades to this): identical to §0's behavior — contact is never handed to a customer through `GET /offers/details/:id`, for anyone but the owner/admin. Pairley captures the lead; the admin or merchant follows up manually.
  - **`MERCHANT_MANAGED`** (built, tested, disabled by default): restores direct reveal — a `CLAIMED` business's contact unlocks for a signed-in customer once they've expressed interest in that specific offer (the interest-gated behavior from the prior round, now opt-in rather than removed). An `UNCLAIMED` business never reveals contact in either mode.
- **Bulk-imported merchants are `UNCLAIMED` again**, not `ADMIN_CURATED` — reconfirming §0's decision; `ADMIN_CURATED` remains in the Postgres enum, inert, per this project's "deprecate, don't drop" precedent.
- **`LeadSource`** — new enum (`WEBSITE` / `MOBILE_APP`), additive column on `Lead` (`@default(WEBSITE)`, safe against existing rows). Set by the client on `POST /offers/lead` (`Capacitor.isNativePlatform()` on the frontend), defaults to `WEBSITE` when omitted.
- **Admin Leads dashboard** — `GET /admin/leads` now also returns `source`; `LeadManagementPanel.jsx` gained a Source column (Website/Mobile App) and relabeled the Status header to "Follow-up Status". The underlying `LeadStatus` enum values (`NEW`/`CONTACTED`/`CONVERTED`/`NOT_INTERESTED`) were deliberately left unchanged rather than relabeled to the product owner's suggested New/Contacted/Interested/Converted/Closed — that enum is shared with Module 13's merchant-facing lead flow, so relabeling it is a platform-wide change judged out of scope for this round.
- **Live verification (2026-07-31)**: real browser (Playwright + Chromium), real dev backend, real Neon database — import one offer, upload one image, publish, browse anonymously (no contact info, no chat), register/authenticate a customer, submit interest (confirmation copy: "Thank you for your interest! ... Our team or the merchant will contact you shortly.", zero contact/chat/navigation elements), confirm the lead appears in the Admin Leads dashboard with correct Source ("Website") and Follow-up Status ("NEW"). All test data (business, offer, lead, test customer) deleted afterward; production counts restored.

---

## 1. Two-stage workflow, by design

Excel/CSV import creates DRAFT offers and assigns each a short `offer_code` — **before any image exists**. Images are matched to offers by that code in a separate step. Only an explicit Publish action (after image mapping and admin preview) makes offers live.

```
Excel Import → validate → create Offers (DRAFT) + offer_code
                                  ↓
                    Bulk Image Upload (ZIP or multi-file)
                                  ↓
                    match by offer_code → cover_image / gallery_images
                                  ↓
                         Admin Preview
                                  ↓
                    Publish → OfferStatus DRAFT → ACTIVE
```

Batch status lifecycle: `QUEUED → VALIDATED → CREATING → CREATED → PUBLISHING → COMPLETED` (or `FAILED` at any point). CREATING/CREATED and PUBLISHING/COMPLETED are deliberately separate pairs, not one "publish" — see `prisma/migrations/20260731000000_bulk_offer_import/migration.sql` for why.

## 2. The reusable core

Per the explicit requirement that validation/processing logic must support CSV/XLSX today and JSON/REST/merchant self-upload later without duplicating business logic:

- **`bulkOfferRow.types.ts`** — `BulkOfferRowInput` (raw strings, untyped) and `NormalizedBulkOffer` (validated, typed). Format-agnostic; nothing here knows what a spreadsheet is.
- **`bulkOfferValidation.ts`** — `validateBulkOfferRow()`, pure and side-effect free, same discipline as `offerVisibility.ts`. Reused verbatim by preview and publish, so they can never disagree about which rows are usable.
- **`bulkOfferParsers.ts`** — `parseCsvRows()` / `parseXlsxRows()`, each producing identical `BulkOfferRowInput[]`. A new format is a new function with this signature; nothing downstream changes.
- **`bulkImageMatching.ts`** — `decideImageMapping()`, pure filename-to-offer resolution. No I/O, no upload, nothing to mock in a test.

Adding CSV/XLSX support today and JSON/REST/self-upload later means adding adapters, never touching validation.

## 3. Validation

Required: Merchant Name, Category, Offer Title, Address, City, State, Pincode (6 digits — see §6), Offer Type (matched against the `OfferType` enum, case/spacing-normalized), Original/Offer Price (offer must be strictly lower), Minimum Participants (≥1), Valid From/Until (Until after From), Contact Number (10-15 digits).

Optional with format checks when present: WhatsApp Number, Email, Latitude/Longitude (must both be present together, or neither — a lone half is worse than none).

**Warnings, not errors:** a discount ≥70% is flagged but still `VALID` — reusing the exact threshold from the `MODULE15_MERCHANT_OFFER_VALIDATION.md` production audit, which flagged both real bad-data rows found there with zero false positives.

**Duplicate detection** is two separate passes: `findDuplicateRowIndexes()` flags a second row in the *same upload* describing the same offer (merchant+city+title, case/whitespace-normalized); a batched `Business.findMany` (one query, not one per row) matches against *existing* businesses by phone.

## 4. Offer ID and image matching

Every `Offer` gets `offer_code`, a Postgres-native autoincrement integer (`OFF` + zero-padded 6 digits for display — the column stores the bare int). Bulk Image Upload matches uploaded files to offers **by this code alone** — never merchant name, offer title, or category, which are free text ChatGPT/an admin can phrase inconsistently.

```
OFF000123.jpg    -> offer_code 123, hero (slot 0)
OFF000123_1.jpg  -> offer_code 123, gallery position 1
OFF000123_2.jpg  -> offer_code 123, gallery position 2
```

Matching is scoped to the uploading batch's own offers only (`offerCodeToId` is built from that batch's `created_offer_id`s) — a code that happens to exist in a different batch can never match, so one admin's upload can't silently paint another's offers.

## 5. Bulk Image Upload — a deliberate scope decision

Images are processed **synchronously within the upload request**, not deferred to a background scheduler tick, unlike offer creation/publish. This is a considered choice, not an oversight: `bulk-image-import.service.ts`'s docstring explains it in full, but in short — offer creation/publish can defer to ticks because the data they need (`BulkImportRow.normalized`) is already durably persisted; an uploaded image's bytes are not durably persisted anywhere until they reach S3, and this codebase has no queue or staging store to hand them off to a later tick without either losing them on a restart or, equivalently, just uploading them now.

"Background" here means what it can honestly mean without a message-queue rewrite of the platform: `BulkImportBatch.mapped_images`/`failed_images` update per file as the request proceeds, so a client polling `GET /admin/bulk-import/:id` sees live progress while the upload is still in flight. Re-uploading the same ZIP/files is a safe retry path — an already-`MAPPED` slot is never overwritten, only a `FAILED` or never-attempted one is filled.

ZIP extraction uses `unzipper` (streaming), not `adm-zip` (whole-archive-in-memory) — a several-thousand-image archive shouldn't be loaded whole.

## 6. Real gaps found and fixed while building, not assumed away

- **`Business.pincode` is required and non-nullable**, but neither the original field list nor the initial row schema included it. Traced from the schema before writing the create call, not discovered via a runtime error. Added as its own validated (6-digit), required field.
- **Slot-reservation ordering bug**, found by writing the test for it: the first implementation marked an image's slot "taken" *before* attempting its upload, so a failed upload would incorrectly block a later, valid file in the same request from filling that same slot. Fixed by reserving only after a genuinely successful upload. Regression test: `bulk-image-import.service.spec.ts` — "does not block a subsequent valid file for a slot whose first attempt failed."
- **`exceljs`'s `npm audit` flags** (high via `archiver`→`glob`/`minimatch`; moderate via `uuid`) were verified, not waved through: `archiver` is required only by exceljs's XLSX *writer* (`lib/stream/xlsx/workbook-writer.js`), which this codebase never calls (read-only `workbook.xlsx.load`); `uuid` is called only as bare `uuidv4()`, which the CWE-787 advisory (exploitable only with an explicit `buf` argument to v3/v5/v6) doesn't affect at all. Confirmed by grepping exceljs's own source, not assumed from the library's reputation.
- **Cell-value stringification** (`toStringCell` in `bulkOfferParsers.ts`) originally used a blanket `String(value)` fallback, which `no-base-to-string` correctly flagged — an exceljs rich-text/formula/hyperlink cell is an object, and blind stringification produces `"[object Object]"` silently. Rewritten to extract the actual string from each known cell shape explicitly.

## 7. End-to-end verification (2026-07-31)

No `chromium-cli` or working headless browser was available in this environment (Playwright's CLI installed via `npx` but had no resolvable local browser binary; a full install was judged too large/uncertain a side-task for this session). In its place, the **entire real pipeline** was exercised against the live dev server, the real production Neon database, and real S3 — not mocked, not simulated:

1. Uploaded a real CSV (`VERIFICATION TEST - Bulk Import`) via `POST /admin/bulk-import` with a real admin JWT → `201`, file genuinely landed in S3, `VALIDATED` with correct counts.
2. `POST /admin/bulk-import/:id/create-drafts` → `BulkImportScheduler`'s real `@Cron` tick picked it up within 5 seconds → `Business` created with `business_status: ADMIN_CURATED` *(historical — see §0/§0b: this status is now `UNCLAIMED`, the field value at the time this pass was run)*, `source: ADMIN`; `Offer` created `DRAFT` with `offer_code: 17` (correctly continuing the sequence from 16 pre-existing offers).
3. Uploaded a real JPEG named `OFF000017.jpg` via `POST /admin/bulk-import/:id/images` → matched, uploaded to S3, `Offer.cover_image` set to the real S3 URL.
4. `POST /admin/bulk-import/:id/publish` → scheduler flipped the offer `DRAFT → ACTIVE`; batch reached `COMPLETED` two ticks later.
5. **The full circle**: hit `GET /offers/details/:id` — the real customer-facing endpoint — for this newly-created offer. Anonymous: no contact, `SIGN_UP_REQUIRED`. Signed in, no interest: no contact, `SHOW_INTEREST_REQUIRED`. After `POST /offers/lead` (Show Interest): contact `AVAILABLE`, real phone number returned. Confirms the `ADMIN_CURATED` business status this module produces is actually treated identically to `CLAIMED` by the entitlement logic added for the customer-flow revision — not just in isolated unit tests, but composed correctly end to end.
6. All test data (business, offer, lead, bulk import batch/rows/images) deleted afterward; production counts confirmed restored to their exact pre-test values (16 offers, 18 businesses). Two small test objects (a 479-byte CSV, a 287-byte JPEG) remain under `bulk-import/` in S3 — `StorageService` has no delete method, and adding one solely for this cleanup was judged out of scope.

**What this does not replace:** a literal browser click-through of `BulkImportPanel.jsx` — drag-and-drop interaction, the progress bar animating, visual layout. The backend behavior it drives is proven correct against real infrastructure; the UI rendering itself has not been seen rendered.

## 8. Tests

| Suite | Count |
|---|---|
| `bulkOfferValidation.spec.ts` | 33 |
| `bulkImageMatching.spec.ts` | 22 |
| `bulkOfferParsers.spec.ts` | 12 |
| `sheetFileValidation.spec.ts` | 5 |
| `bulk-import.service.spec.ts` | 18 |
| `bulk-image-import.service.spec.ts` | 10 |
| `bulk-import.scheduler.spec.ts` | 6 |
| **Backend `src/bulk-import/` total** | **107** |
| `bulkImportApi.test.js` (frontend, CSV report builder) | 5 |

Backend full suite: 327/328 (the one failure is `app.controller.spec.ts`, the same pre-existing, unrelated Nest scaffold issue documented in every prior module this session). Frontend: 67/67. Both repos build clean; lint clean on every file in this module (the only lint findings are the established, pre-existing `as any` mock-typing pattern in `.spec.ts` files, identical to every other test file in this codebase).

## 9. API surface

All under `/api/admin/bulk-import`, admin-only (`JwtAuthGuard` + `RolesGuard` + `Role.ADMIN`):

| Method | Path | Purpose |
|---|---|---|
| POST | `/` | Upload offer sheet (CSV/XLSX) — parses, validates, persists rows |
| GET | `/history` | Import history list |
| GET | `/:id` | Batch status/progress |
| GET | `/:id/preview` | Validation aggregate (counts, distinct merchants) |
| GET | `/:id/errors` | INVALID/DUPLICATE rows for the downloadable report |
| POST | `/:id/create-drafts` | Begin creating DRAFT business+offer per valid row (background) |
| POST | `/:id/images` | Upload image files (multi-file/folder) |
| POST | `/:id/images/zip` | Upload a ZIP of images |
| POST | `/:id/publish` | Begin flipping created offers DRAFT → ACTIVE (background) |

## 10. Known future enhancements (not blocking this release)

- [ ] A real 1,000+ row / 1,000+ image batch, to confirm the stated 10,000-scale targets in practice (verified so far at n=1)
- [ ] Small orphaned test objects left in S3 from live verification passes (`bulk-import/`, `_quarantine_probe/`) — cosmetic; `StorageService` has no delete method, and the AWS key's `ListBucket` deny (AWS `AWSCompromisedKeyQuarantineV3` quarantine — see project memory) prevents enumerating the bucket to audit them properly. Rotating the AWS key remains an open action item for the user.
- [ ] `MERCHANT_MANAGED` mode (§0b) is built and tested but has not been exercised live end-to-end — only `ADMIN_MANAGED` (the launch default) has real-browser verification. Worth a live pass before ever flipping the env var in production.
- [ ] `LeadStatus` enum relabeling (New/Contacted/Interested/Converted/Closed) — deferred, shared with Module 13's merchant lead flow (§0b)
