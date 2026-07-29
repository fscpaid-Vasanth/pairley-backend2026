# AI Public Offer Discovery & Import Tool — Proposal (STEP 1)

**Status: design only. No code written. Awaiting approval before implementation.**

Module number not assigned — see "Naming & scope" below, that's your call.

---

## 0. Executive summary

Roughly **70% of what this spec describes already exists** in the backend
(Modules 9–12) and has never been given a proper admin entry point. The
website-URL import endpoint has *no UI at all* today — it's reachable only
via API. So the single highest-value, lowest-risk piece of this request is
Phase 1: build the screen.

The genuinely new engineering is narrower than the spec implies, and lands
in four places:

1. **Extraction breadth.** The spec lists ~20 fields to extract. Today the
   pipeline extracts **five**: title, description, image, price, rawText.
   Everything else in your list (address, phone, GST, T&C, min/max
   customers, socials, maps location, logo) is not extracted at all.
2. **Per-field confidence.** Today confidence is a single scalar per offer.
   "Highlight low-confidence fields for manual review" needs per-field.
3. **Merchant acquisition (WhatsApp invite + claim suggestion at signup).**
   Does not exist in any form.
4. **Social sources.** Blocked — see §7. This is the deferred Meta work.

Two things in the spec are **already true and need no work**:

- *"Customer details remain hidden"* — Module 13's lead masking already does
  exactly this. An unclaimed business's leads are masked by default; there is
  no code path that reveals a customer's name or mobile before an explicit
  unlock. No new privacy work needed.
- *"Business address/phone/website/GST/socials/maps/logo storage"* — every
  one of these columns **already exists on `Business`**. Extraction just
  never populates them. Zero schema change needed for business contact data.

---

## 1. Naming & scope

Two notes before anything else.

**This subsumes the deferred Meta import work.** The "Paste Social Media
Link → public Instagram/Facebook posts" input in your spec *is* the
Instagram/Facebook import that's been deferred pending Meta Business
Verification + App Review. It's still blocked by the same external
dependency. I've scoped it as the last phase and deliberately limited it to
what's achievable without bypassing anything (§7) — but if Meta verification
is still outstanding, that phase cannot ship regardless of what we build.

**Module number.** "Module 13" was reassigned to the Deal Coordination
Assistant. This work has no number. Tell me what you want it called and I'll
use that consistently in commits and tags.

---

## 2. What already exists (verified against the codebase, not assumed)

| Spec requirement | Existing implementation | Location |
|---|---|---|
| Website URL import | `POST /discovery/import` — SSRF-guarded fetch, HTML-only, size/redirect/timeout caps | `url-fetch.service.ts` |
| Poster / PDF import | `POST /discovery/import-file` — magic-byte validation → S3 → OCR (`tesseract.js`) or PDF text layer | `import-orchestration.service.ts` |
| Job tracking | `ImportJob` (QUEUED→PROCESSING→DONE/FAILED), `GET /discovery/jobs` | `import-job.repository.ts` |
| Convert to Pairley format | `NormalizationService` — discount split, offer_type classification, validity dates | `normalization.service.ts` |
| Candidate creation | `CandidateOfferService` — UNCLAIMED `Business` + DRAFT `Offer` + `OfferVersion` audit row | `candidate-offer.service.ts` |
| Admin review screen | `ReviewQueueService` + `DiscoveredOffersPanel` + `CandidateReviewModal` | `review-queue.service.ts` |
| Approve / Reject / Takedown | All three, each writing an `OfferVersion` audit row, all reversible | `review-queue.service.ts` |
| AI suggestions w/ explainability | `EnrichmentService` + `AiSuggestionsPanel` (Accept/Edit/Reject per field) | `enrichment.service.ts` |
| Duplicate detection | `DuplicateDetectionService` — weighted, offer-level + business-level, advisory only (thresholds 0.55 / 0.5) | `duplicate-detection.service.ts` |
| Duplicate merge/review/ignore | `BusinessConsolidationService` + `BusinessDuplicatesPanel` | `business-consolidation.service.ts` |
| Claim workflow | `ClaimRequestService` — request → admin approve → OTP → ownership transfer | `claim-request.service.ts` |
| Customer detail protection | Module 13 lead masking (`leads.unlocked_at`) | `lead.service.ts` |
| WhatsApp send | `sendTemplateMessage()` via Meta Cloud API | `whatsapp.service.ts` |

Your instruction — *"only build the Admin UI and orchestrate the existing
backend components"* — is exactly right for Phase 1, and roughly right for
Phases 3–4. Phase 2 is the one place that needs real new backend work, and
it's the place that makes this tool actually deserve the word "AI."

---

## 3. What's actually missing

### 3.1 No unified discovery entry screen
The admin dashboard has a **Discovered Offers** tab showing the *results*,
with a poster/PDF upload card embedded in it. There is **no URL input
anywhere in the UI**. The endpoint has existed since Module 9 and has only
ever been called by hand.

### 3.2 Extraction produces 5 fields, spec wants ~20

`ExtractedFields` today is `{title, description, image, price, rawText}`.
Nothing more. Specifically missing, with where each would land:

| Spec field | Status | Destination column | New column? |
|---|---|---|---|
| Business Name | Derived from hostname only (`"example.com (imported)"`) | `Business.business_name` | No |
| Business Category | **Hardcoded `"shopping"`** for every candidate | `Business.category` | No |
| Business Address | Not extracted | `Business.address/city/state/pincode` | No |
| Phone Number | Not extracted | `Business.mobile` | No |
| Website | Not extracted | `Business.website` | No |
| GST | Not extracted | `Business.gst_number` | No |
| Google Maps location | Not extracted | `Business.geo_lat/geo_lng` | No |
| Social links | Not extracted | `Business.instagram/facebook` | No |
| Logo | Not extracted | `Business.logo` | No |
| Offer Name / Description | ✅ extracted | `Offer.title/description` | No |
| Original / Offer Price | ✅ (normalization splits discounts) | `Offer.original_price/offer_price` | No |
| Discount % | Derived, never stored (correct — don't store derivable values) | — | No |
| Offer Type | ✅ keyword classification | `Offer.offer_type` | No |
| Offer Validity | ✅ best-effort date parsing | `Offer.end_date` | No |
| Offer Images | ✅ (single cover) | `Offer.cover_image/gallery_images` | No |
| Confidence Score | ✅ scalar | `Offer.confidence_score` | No |
| Source URL | ✅ | `Offer.original_import_url` | No |
| **Minimum Customers** | Not extracted | `Offer.required_people` | No |
| **Maximum Customers** | Not extracted | — | **YES** |
| **Terms & Conditions** | Not extracted | — | **YES** |

**Only two new columns in the entire extraction expansion.** Everything else
is a column that already exists and has simply never been filled in.

### 3.3 Confidence is a single scalar
`Offer.confidence_score` measures *extraction completeness*;
`Offer.enrichment_confidence` measures *suggestion certainty*. Neither is
per-field, so "highlight low-confidence fields" can't be rendered today.

### 3.4 Admin can only override 5 fields at approval
`CandidateOverrides` = `{category, offerType, merchantType, tags, keywords}`.
The spec wants "editing of every field" plus **Save Draft** and **Send for
Review** actions, neither of which exists (approve/reject/takedown are the
only three transitions).

### 3.5 No merchant acquisition machinery
No invite message, no interest aggregation, no rate limiting, no
claim-suggestion at signup. All new.

### 3.6 No AI dashboard metrics endpoint
Every metric you listed is derivable from existing tables — but nothing
aggregates them today.

### 3.7 No robots.txt handling
`UrlFetchService` has strong *security* controls (SSRF, size, redirects,
content-type) but does not check `robots.txt`. Given your Important Business
Rule, I'd add this. See §9.

---

## 4. Proposed architecture

The core principle: **one pipeline, many sources.** Rather than build a
parallel "AI discovery" path, the new screen feeds the *existing*
orchestration service, and every source type converges on the same
candidate → review → approve → publish flow that Modules 9–12 already prove.

```
                    ADMIN: AI Offer Discovery screen
                                  │
        ┌──────────────┬──────────┴────────┬──────────────────┐
        │              │                   │                  │
   Website URL    Poster image        PDF brochure      Social link
        │              │                   │                  │
        ▼              ▼                   ▼                  ▼
  UrlFetchService  FileValidation    FileValidation    SocialResolver
  (SSRF guard,     (magic bytes)     (magic bytes)     (oEmbed / OG only
   robots.txt)          │                   │           — never bypasses
        │               ▼                   ▼             auth; §7)
        │        ImagePreprocess       PdfTextService          │
        │               │                   │                 │
        │               ▼                   │                 │
        │          OcrService               │                 │
        │               │                   │                 │
        ▼               └─────────┬─────────┘                 │
  ContentExtraction         TextExtraction ◄──────────────────┘
        │                         │
        └────────────┬────────────┘
                     ▼
         ┌───────────────────────┐
         │  FieldExtraction      │  ◄── NEW (Phase 2). Deterministic
         │  (deterministic)      │      passes for phone/GST/address/
         └───────────┬───────────┘      maps/socials — regex-level,
                     │                  no model call needed.
                     ▼
         ┌───────────────────────┐
         │  EnrichmentProvider   │  ◄── existing abstract interface.
         │  ├ RuleBased (today)  │      Phase 2 adds the OpenAI provider
         │  └ OpenAI    (NEW)    │      as a second implementation —
         └───────────┬───────────┘      no consumer changes.
                     ▼
         NormalizationService  →  CandidateOfferService
                     │                    │
                     ▼                    ▼
         DuplicateDetectionService   UNCLAIMED Business
                     │               + DRAFT Offer (review_required)
                     ▼               + OfferVersion (AI_IMPORT)
              ADMIN REVIEW QUEUE
                     │
        ┌────────────┼────────────┬──────────────┐
        ▼            ▼            ▼              ▼
     Approve      Reject     Save Draft    Send for Review
        │                     (NEW)            (NEW)
        ▼
   Offer ACTIVE, publicly visible, business still UNCLAIMED
        │
        ▼
   Customers show interest → Lead (masked, Module 13)
        │
        ▼
   MerchantInviteService (NEW) — aggregated, count-only WhatsApp invite
        │
        ▼
   Merchant registers → BusinessMatchService (NEW) suggests "Claim this"
        │
        ▼
   Existing ClaimRequestService → admin approve → OTP → ownership transfer
```

**Why the AI step is a provider, not a service.** `EnrichmentProvider` is
already an abstract class with exactly one implementation
(`RuleBasedEnrichmentProvider`). Adding an OpenAI provider is a second
implementation behind the same interface — `EnrichmentService` and
everything upstream of it change zero lines. This was the stated plan when
Module 11 was built; this module is where it finally pays off.

**Why AI stays advisory.** Module 11's Decision 6 (explainability) and
Decision 4 (recommendation only, never auto-merge) hold here unchanged. The
model suggests; `enrichment_metadata` records `{suggested, accepted,
confidence, rationale}` per field; the admin decides. Nothing auto-publishes.

---

## 5. Admin UI

### 5.1 Navigation

Add one tab. Existing tabs are unchanged.

```
Dashboard │ Shop Onboardings │ Customers │ Deals Moderation │
🤖 AI Offer Discovery │ Discovered Offers │ Claim Requests │
Business Duplicates │ Support │ Launch Pass
```

`🤖 AI Offer Discovery` is the **input** screen. `Discovered Offers` stays
the **output** queue. Keeping them separate matches how you described it and
avoids turning one panel into two unrelated jobs.

### 5.2 AI Offer Discovery screen

```
┌────────────────────────────────────────────────────────────────┐
│  🤖  AI OFFER DISCOVERY                                        │
│  Discover publicly promoted offers and convert them to Pairley │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌─ SOURCE ───────────────────────────────────────────────┐   │
│  │  [ 🔗 Website ] [ 🖼 Poster ] [ 📄 PDF ] [ 📱 Social ] │   │
│  ├────────────────────────────────────────────────────────┤   │
│  │                                                        │   │
│  │  Website URL                                           │   │
│  │  ┌──────────────────────────────────────────────────┐ │   │
│  │  │ https://specgym.in/offers                        │ │   │
│  │  └──────────────────────────────────────────────────┘ │   │
│  │  Public pages only. We respect robots.txt and never   │   │
│  │  access content behind a login.                       │   │
│  │                                                        │   │
│  │                              [  Analyze using AI  ]   │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌─ RECENT IMPORTS ───────────────────────────────────────┐   │
│  │ 🔗 specgym.in          just now      ⏳ Processing     │   │
│  │ 🖼 monsoon-offer.jpg   2 min ago     ✅ Done  → Review │   │
│  │ 📄 menu-q3.pdf         14 min ago    ✅ Done  → Review │   │
│  │ 📱 instagram.com/p/…   1 hr ago      ❌ Not public     │   │
│  │    This post isn't publicly accessible. Upload a       │   │
│  │    screenshot of it instead.                           │   │
│  └────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

One source-type selector rather than four stacked inputs — four always-visible
inputs where only one can be used reads as a form you must fill in
completely. The recent-imports feed is `GET /discovery/jobs` (already
exists), polled the same way `PosterUploadCard` already polls it, with a
direct hand-off link into the review queue on success.

### 5.3 Candidate review — per-field confidence

Extends the existing `CandidateReviewModal`. Every field becomes editable
(§3.4), with a confidence band per field.

```
┌────────────────────────────────────────────────────────────────┐
│  REVIEW CANDIDATE                          Overall: 72% ● High │
│  Source: specgym.in/offers                    [ View source ↗ ]│
├─────────────────────────────┬──────────────────────────────────┤
│  EXTRACTED                  │  SOURCE PREVIEW                  │
│                             │                                  │
│  Business Name      ● High  │   ┌────────────────────────┐    │
│  ┌───────────────────────┐  │   │                        │    │
│  │ Spec Gym              │  │   │   [poster / page       │    │
│  └───────────────────────┘  │   │    screenshot]         │    │
│                             │   │                        │    │
│  Category           ◐ Med   │   │                        │    │
│  ┌───────────────────────┐  │   └────────────────────────┘    │
│  │ Gym              ▼    │  │                                  │
│  └───────────────────────┘  │  ⚠ 2 fields need review          │
│                             │  • Phone — low confidence        │
│  Phone              ○ Low   │  • GST — not detected            │
│  ┌───────────────────────┐  │                                  │
│  │ 9876543210            │  │  🔁 Possible duplicate — 96%     │
│  └───────────────────────┘  │     "Spec Gym Anna Nagar"        │
│  ⚠ Verify before publishing │     [ Merge ] [ Review ] [ Ignore ]│
│                             │                                  │
│  Original Price     ● High  │                                  │
│  ┌───────────────────────┐  │                                  │
│  │ ₹30,000               │  │                                  │
│  └───────────────────────┘  │                                  │
│                             │                                  │
│  Min People  ◐   Max People ○│                                 │
│  ┌─────────┐   ┌──────────┐ │                                  │
│  │ 5       │   │ —        │ │                                  │
│  └─────────┘   └──────────┘ │                                  │
│  → ₹6,000 per head          │                                  │
│                             │                                  │
│  [ … remaining fields … ]   │                                  │
├─────────────────────────────┴──────────────────────────────────┤
│  [ Reject ]        [ Save Draft ]  [ Send for Review ]  [ Approve ] │
└────────────────────────────────────────────────────────────────┘
```

Confidence bands: **● High ≥ 0.7**, **◐ Medium 0.4–0.7**, **○ Low < 0.4** —
matching the thresholds `DiscoveredOffersPanel`'s existing `ConfidenceBadge`
already uses, so one visual language across the module.

Low-confidence fields get a border treatment and a warning line, not a
blocking modal. The admin is the gate; the UI's job is to direct attention,
not to obstruct.

### 5.4 AI Discovery dashboard

```
┌──────────────────────────────────────────────────────────────┐
│  Imported     Approved    Rejected    Claimed    Registered  │
│    248          171          52          38          22      │
│                                                              │
│  Customer Interests: 1,204     Conversion Rate: 12.9%        │
│  (registrations ÷ approved offers)                           │
└──────────────────────────────────────────────────────────────┘
```

Every number here is a `count()` over existing tables — see §6.

---

## 6. API surface

### New endpoints

| Method | Path | Purpose | Phase |
|---|---|---|---|
| `POST` | `/discovery/import-social` | Accepts an Instagram/Facebook post URL; oEmbed/OG only | 5 |
| `PATCH` | `/discovery/review/:id` | Save Draft — persist edits without changing review status | 3 |
| `POST` | `/discovery/review/:id/send-for-review` | Return a draft to the review queue | 3 |
| `GET` | `/discovery/metrics` | AI Discovery dashboard aggregates | 4 |
| `POST` | `/discovery/businesses/:id/invite` | Manually trigger a merchant invite (admin override) | 4 |
| `GET` | `/business/claim-suggestions` | At-signup match against UNCLAIMED businesses | 4 |

### Changed endpoints

| Method | Path | Change | Phase |
|---|---|---|---|
| `POST` | `/discovery/review/:id/approve` | `CandidateOverrides` widened from 5 fields to the full editable set | 3 |
| `GET` | `/discovery/review/:id` | Response gains `field_confidence` (from extended `enrichment_metadata`) | 2 |
| `GET` | `/discovery/jobs` | Response gains a normalized `failure_reason` code alongside the raw `error` string | 1 |

### Unchanged (reused as-is)
`POST /discovery/import`, `POST /discovery/import-file`,
`GET /discovery/jobs/:id`, `POST /discovery/review/:id/reject`,
`POST /discovery/review/:id/takedown`, all bulk endpoints, the entire claim
API, and the entire business-consolidation API.

---

## 7. Social sources — the honest constraint

Your Important Business Rule and the technical reality point the same way,
so this is not a trade-off, just a limit.

**What's actually possible without bypassing anything:**

- **Instagram/Facebook public posts** expose Open Graph tags and an oEmbed
  endpoint. oEmbed for Instagram requires a Facebook App with
  **`oembed_read`**, which requires **App Review + Business Verification** —
  the same gate the deferred Meta import work has always sat behind.
- Bare OG-tag fetching against an Instagram post URL returns a login wall
  for most content. It works inconsistently and degrades without notice.

**What I will not build:** headless-browser rendering to defeat the login
wall, session-cookie replay, unofficial private APIs, or rotating requests
to evade rate limits. Each of these is exactly what your rule prohibits, and
each also breaches the platforms' terms.

**Proposed behavior:** accept the URL, attempt oEmbed if credentials are
configured, fall back to a plain OG fetch, and on failure produce a `FAILED`
`ImportJob` with reason `SOURCE_REQUIRES_PERMISSION` and admin-facing copy:
*"This post isn't publicly accessible. Upload a screenshot of it instead."*
The screenshot path already works today — it's the existing poster OCR
pipeline, and it's a completely legitimate way to process a post you can see.

This is why Phase 5 is last: it's the only phase with an **external blocker
neither of us controls**, and the screenshot fallback covers the use case in
the meantime.

---

## 8. Merchant acquisition flow

```
Offer approved & published (business still UNCLAIMED)
        │
        ▼
Customer shows interest → Lead created (Module 13)
        │                        │
        │                        └─→ customer_name / customer_mobile
        │                            MASKED — no unlock is possible,
        │                            there is no merchant account yet
        ▼
MerchantInviteService (NEW)
        │
        ├─ Has the business a phone number?  ── no ──→ no invite possible
        │                                              (flag in admin UI)
        ├─ Interest count ≥ threshold?       ── no ──→ wait
        ├─ Invited in the last N days?       ── yes ─→ suppress
        │
        ▼
WhatsApp template message (count only — no name, no phone, no email)
        │
        ▼
Merchant taps "Register Now" → /business/register
        │
        ▼
BusinessMatchService (NEW) — matches signup name/phone/website/city
against UNCLAIMED businesses, reusing DuplicateDetectionService's
weighted scoring
        │
        ▼
"We found Spec Gym on Pairley. Is this your business?  [ Claim ]"
        │
        ▼
Existing ClaimRequestService → admin approval → OTP → ownership transfer
        │
        ▼
Merchant now owns the business, sees its leads, can unlock customers
```

**Three constraints worth naming:**

1. **The invite must be a WhatsApp *template* message.** There's no inbound
   message from the merchant, so the 24-hour session window is closed and
   free-form text will be rejected by Meta. **You will need to create and get
   approval for a new message template in Meta Business Manager** — that's an
   external dependency with a review turnaround, so it's worth starting early
   if you approve Phase 4.

2. **The invite depends on Phase 2.** An unclaimed business's `mobile` is
   `null` today because extraction never populates it. Phase 4 cannot deliver
   anything without Phase 2 landing first.

3. **Aggregation and rate limiting are mandatory, not nice-to-have.** One
   message per lead would be spam and would risk the WhatsApp number's
   quality rating. The proposed rule: invite at a configurable interest
   threshold, then at most once per business per N days, with every send
   logged.

**Privacy in the message** — count only, exactly as you specified. The
message never contains a customer name, phone, or email, and this is
enforced by the template's own parameter list (business name, offer title,
interest count) rather than by a code convention, so it cannot regress.

---

## 9. Database impact

**Additive only. No destructive changes. No backfill required.**

### New columns

| Table | Column | Type | Why |
|---|---|---|---|
| `offers` | `max_people` | `Int?` | Spec's "Maximum Customers" — no equivalent exists (`required_people` is the minimum) |
| `offers` | `terms_conditions` | `String?` | Spec's "Terms & Conditions" — no equivalent exists |

That is the **entire** new-column list for extraction. Every other field in
your spec maps to a column that already exists.

### New table (Phase 4)

```prisma
model MerchantInvite {
  id            String   @id @default(uuid())
  business_id   String
  offer_id      String?
  channel       String   // "WHATSAPP" — one value today, extensible
  interest_count Int     // what the count was at send time
  status        String   // QUEUED | SENT | FAILED | SUPPRESSED
  suppress_reason String?
  sent_at       DateTime?
  created_at    DateTime @default(now())

  @@index([business_id, created_at])
  @@index([status, created_at])
  @@map("merchant_invites")
}
```

Standalone (no relation), mirroring `WhatsAppMessage` and
`lead_interaction_events`. Serves three jobs at once: rate-limit source of
truth, delivery audit, and acquisition-funnel analytics.

### Reused, not duplicated

- **Per-field confidence** → extends the existing `enrichment_metadata` Json
  (`{suggested, accepted, confidence, rationale}` per field). No new column.
- **Discount %** → derived at read time. Deliberately not stored; storing a
  value derivable from two other columns invites them drifting apart.
- **Business contact data** → `address`, `city`, `state`, `pincode`,
  `mobile`, `website`, `instagram`, `facebook`, `gst_number`, `geo_lat`,
  `geo_lng`, `logo` **all already exist** on `Business`.

### Migration mechanism
`prisma db push` (this project's actual sync mechanism), plus a hand-written
`migration.sql` under `prisma/migrations/` as historical documentation, per
established convention.

---

## 10. Compliance controls

Your Important Business Rule, translated into things that either exist or
get built:

| Control | Status |
|---|---|
| Never access content behind a login | Enforced — `UrlFetchService` sends no credentials and follows no auth redirects |
| Never bypass a platform's access restrictions | Enforced by design — §7, fail-with-guidance rather than defeat-the-wall |
| SSRF / internal-network protection | ✅ exists (`ip-guard.util.ts`) |
| Response size, timeout, redirect caps | ✅ exists |
| **Respect `robots.txt`** | ❌ **missing — proposed for Phase 1** |
| **Identify our crawler honestly via User-Agent** | Worth verifying/setting in Phase 1 |
| Source URL retained for attribution | ✅ exists (`original_import_url`) |
| Human review before anything publishes | ✅ exists — nothing auto-publishes |
| Takedown path if a merchant objects | ✅ exists (`takedown`, reversible, audited) |

The robots.txt check is a small addition (fetch, parse, cache per host,
honor `Disallow` for our UA) and it's the one place where the current code
doesn't yet match the rule you wrote. I'd fold it into Phase 1.

---

## 11. Phasing

Each phase is independently shippable and independently reviewable, per the
usual gate.

| Phase | Scope | New backend? | Risk |
|---|---|---|---|
| **1** | AI Offer Discovery screen; URL import finally reachable from the UI; jobs feed; robots.txt + User-Agent | Minimal (robots.txt, failure-reason codes) | Low |
| **2** | Extraction breadth (~20 fields), per-field confidence, OpenAI `EnrichmentProvider` | Substantial — the real work | Medium |
| **3** | Full-field review editor, Save Draft, Send for Review, widened approve overrides | Moderate | Low |
| **4** | Merchant invite (WhatsApp) + claim suggestion at signup + metrics dashboard | Moderate + external Meta template approval | Medium |
| **5** | Social sources (oEmbed/OG only) | Small — but **externally blocked** on Meta verification | Blocked |

**Recommendation: approve Phase 1 alone first.** It's a few days of work, it
unblocks a capability that's been sitting unreachable in production since
Module 9, and it will teach us more about what extraction actually needs than
any amount of further design will.

---

## 12. Files affected (estimate)

### Phase 1
**Backend**: `url-fetch.service.ts` (robots.txt, User-Agent),
`discovery.controller.ts` (failure-reason normalization),
new `robots.service.ts` + spec.

**Frontend**: new `AiOfferDiscoveryPanel.jsx` + `.css`, new
`SourceInputCard.jsx`, `AdminDashboard.jsx` (one tab), `constants.js`.
`PosterUploadCard.jsx` gets reused inside the new panel rather than
duplicated.

### Phase 2
**Backend**: new `field-extraction.service.ts` + spec, new
`openai-enrichment.provider.ts` + spec, `enrichment.service.ts`,
`candidate-offer.service.ts`, `confidence-scoring.service.ts`,
`content-extraction.service.ts`, `text-extraction.service.ts`,
`schema.prisma` + migration.

**Frontend**: `CandidateReviewModal.jsx`, `AiSuggestionsPanel.jsx`.

### Phase 3
**Backend**: `review-queue.service.ts`, `review-queue.controller.ts`.
**Frontend**: `CandidateReviewModal.jsx`.

### Phase 4
**Backend**: new `merchant-invite.service.ts` + spec, new
`business-match.service.ts` + spec, new `discovery-metrics.service.ts` + spec,
`whatsapp.service.ts`, `auth.service.ts` (signup hook), `schema.prisma`.
**Frontend**: new `AiDiscoveryMetrics.jsx`, `SignUpPage.jsx` (claim prompt).

### Phase 5
**Backend**: new `social-resolver.service.ts` + spec,
`import-orchestration.service.ts`, `discovery.controller.ts`.
**Frontend**: social tab in `SourceInputCard.jsx`.

---

## 13. Test plan

Following the pattern from Modules 9–13: unit tests on pure logic, live
production-style testing for anything involving real data — every module
since 10 has found real bugs that way and none by unit test alone.

**Unit (Jest, backend):**
- robots.txt parsing: allow/disallow/wildcards/missing file/malformed/unreachable
- field extraction: Indian phone formats, GST checksum shape, address
  patterns, min/max people phrasing, T&C block detection — plus negative
  cases for each (this is where over-eager regex does damage)
- per-field confidence banding at the 0.4 / 0.7 boundaries
- OpenAI provider: mocked responses, malformed JSON, timeout, rate-limit —
  each must degrade to the rule-based provider, never fail the import
- invite suppression: below threshold, within cooldown, no phone number,
  already claimed
- business matching at signup: exact/fuzzy/no match, and the
  must-never-match cases (generic import labels, defaulted category)
- metrics aggregation against a seeded fixture set

**Unit (Vitest, frontend):**
- confidence-band mapping, source-type input validation, failure-reason →
  admin copy mapping

**Live production-style:**
- import a real gym/restaurant/salon page end-to-end
- import a real poster and a real PDF; compare extracted vs. actual
- a deliberately robots.txt-disallowed URL → correct refusal
- a duplicate of an existing business → correct flag, no auto-merge
- full acquisition loop on a **test** business: publish → interest → invite →
  register → match → claim → OTP → ownership transfer

**Explicitly out of scope for automated testing:** anything requiring a real
WhatsApp send to a real merchant. That's manual, on a number you control.

---

## 14. Verification checklist

To be run in a browser before any phase is called done, in the same format
as `MODULE13_BROWSER_VERIFICATION_GUIDE.md`.

**Phase 1** — tab appears for admin only; each source type submits; job
appears and reaches a terminal state; failures show admin-readable copy;
success links into the review queue; a robots-disallowed URL is refused with
a clear reason; a non-admin gets 403 on every discovery route.

**Phase 2** — extracted fields match the source page for a real import;
low-confidence fields are visibly flagged; a page with no phone/GST produces
empty fields rather than hallucinated ones *(the single most important check
in this module — a plausible-looking wrong phone number is worse than a
blank one)*; the OpenAI provider failing mid-import still yields a reviewable
candidate.

**Phase 3** — every field editable; Save Draft persists without publishing;
Send for Review returns it to the queue; Approve applies all edits atomically;
`OfferVersion` history records each transition with the acting admin.

**Phase 4** — invite fires only above threshold; suppressed within cooldown;
**message contains no customer name, phone, or email**; registration
surfaces the claim suggestion; claim → OTP → transfer works end to end;
metrics match hand-counted values.

**Phase 5** — a public post either imports or fails with the screenshot
guidance; **no path exists that accesses non-public content**.

---

## 15. Open questions

These change the build, so I'd like answers before Phase 1 starts — except
where noted.

1. **Module number / name?** (§1)
2. **Interest threshold and cooldown for merchant invites?** My suggestion:
   invite at **3** interests, then at most once per **14 days** per business.
   Needed for Phase 4, not Phase 1.
3. **Should extracted business phone numbers be verified before use?** An
   extracted number could be wrong, or belong to someone else entirely.
   Options: send anyway; require admin confirmation of the number before the
   first invite; or verify by OTP first. **I'd recommend admin confirmation** —
   it's one click, and it prevents messaging a stranger. Needed for Phase 4.
4. **OpenAI budget ceiling?** A per-import cost cap and a monthly ceiling
   would be worth setting before Phase 2 rather than after.
5. **Confirm Phase 1 alone first**, or approve a larger block?

None of these block me from starting Phase 1 except #1 and #5.
