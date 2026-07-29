# Module 14 — AI Public Offer Discovery (Admin), Phase 1

Exposes the AI discovery pipeline that has existed since Modules 9–11
through a real Admin Dashboard screen, and adds the robots.txt compliance
control the module's business rule requires.

**Scope is Phase 1 only.** Phases 2–5 (extraction breadth, per-field
confidence, merchant WhatsApp invitations, acquisition automation, social
imports) are explicitly not built — see
`AI_OFFER_DISCOVERY_ADMIN_TOOL_PROPOSAL.md`.

---

## What this phase actually changes

Three things, and deliberately nothing else:

1. **An entry point.** `POST /discovery/import` (website URL import) has been
   live in production since Module 9 with **no UI at all** — reachable only
   by calling the API directly. It now has a screen.
2. **robots.txt compliance.** The crawler now asks permission before it
   reads. This was the one place the code didn't yet match the compliance
   rule the module was specified under.
3. **Full-field admin review.** The review modal was read-only apart from
   five AI-suggestion fields. Every extracted field is now editable, with a
   Save Draft action that persists edits without publishing.

No new database tables. No new columns. No changes to OCR, extraction,
normalization, duplicate detection, enrichment, or the claim workflow — all
of it is orchestrated, not reimplemented.

---

## 1. AI Offer Discovery screen

New admin tab, `🤖 AI Offer Discovery`, sitting after `Discovered Offers`
per the requested menu order.

The two are deliberately separate panels: this one is the **input** (start an
import), `Discovered Offers` is the **output** (review the queue). Neither
has to do two unrelated jobs, and the per-job **Review →** action is the
bridge between them.

```
┌────────────────────────────────────────────────────────────────┐
│  🤖  AI Offer Discovery                                        │
│  Turn a publicly promoted offer into a Pairley draft.          │
│  Everything imported here lands in Discovered Offers for       │
│  review — nothing is published without your approval.          │
│                                                                │
│  [ 🔗 Website ] [ 🖼 Poster ] [ 📄 PDF ] [ 📷 Screenshot ]    │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  WEBSITE URL                                             │ │
│  │  ┌────────────────────────────────┐ [ ✨ Analyze using AI ]│ │
│  │  │ https://specgym.in/offers      │                      │ │
│  │  └────────────────────────────────┘                      │ │
│  │  🛡 Public pages only. We honour robots.txt and never    │ │
│  │     access content behind a login.                       │ │
│  └──────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────┤
│  RECENT IMPORTS                        Discovered Offers →     │
│  🔗 specgym.in         29 Jul, 4:12 pm    [Review →]  ✅ Done  │
│  🖼 monsoon.jpg        29 Jul, 4:05 pm    [Review →]  ✅ Done  │
│  📄 menu-q3.pdf        29 Jul, 3:58 pm               ⏳ Processing│
│  🔗 competitor.com     29 Jul, 3:41 pm               ❌ Failed │
│     This site's robots.txt asks us not to crawl that page, so  │
│     we haven't. Upload a poster, PDF, or screenshot instead.   │
└────────────────────────────────────────────────────────────────┘
```

**One source visible at a time**, not four stacked inputs — only one can be
used per import, and four always-visible fields read as a form you must fill
in completely.

**Screenshot is its own source** even though it posts to the same endpoint
with the same accepted types as Poster. "Screenshot of a public post" is a
distinct thing in an admin's head, and naming it is what makes the
social-media path discoverable without pretending to support authenticated
Instagram/Facebook imports.

**Polling stops itself.** The recent-imports feed only re-fetches while a job
is non-terminal, matching the restraint of the existing Module 10 upload
card rather than running a permanent 3s timer against the admin API.

---

## 2. Admin review

The existing `CandidateReviewModal` now shows all four things side by side.

| Panel | Content |
|---|---|
| **Original Source** | The uploaded poster inline, the PDF via the authenticated preview proxy, or a link to the source page — unchanged from Module 10 |
| **AI Extracted Content** | *(new)* What the pipeline actually read: title, description, price, OCR confidence, and the full raw text behind a disclosure |
| **Pairley Offer** | *(now editable)* Every field, as it will be published |
| **Confidence** | Percentage plus a High / Medium / Low band |

Editable fields — **all mapping to columns that already exist**:

- *Offer*: name, description, subtitle, category, offer type, original price,
  offer price, minimum customers, start date, end date
- *Business*: name, category, type, phone, website, address, city, state,
  pincode, GST number

Actions: **Reject** · **Save Draft** · **Approve & Publish** · (Take Down,
for already-approved candidates).

**Save Draft** persists edits and leaves the candidate `REVIEW_REQUIRED`, so
it stays in the queue for someone to finish. It writes an `OfferVersion` row
with change type `REVIEW_DRAFT_SAVED`, distinct from `REVIEW_APPROVED`, so
the audit trail tells a saved draft from a publish.

**Coherence is enforced on both sides.** Offer price above original price,
or an end date not after the start date, is rejected — client-side for
immediate feedback, and server-side as the actual gate. Both compare the
*effective* values, using the stored value for whichever side the admin
didn't edit, because editing one half of a pair is the common case.

**A phone-number collision is explained, not 500'd.** `Business.mobile` and
`email` are unique; an admin correcting an extracted number can legitimately
collide with a business already on Pairley. That returns a 400 pointing at
Business Duplicates rather than a Prisma constraint error.

---

## 3. Duplicate detection

Unchanged and reused as-is. `DuplicateBanner` already surfaced offer-level
and business-level flags with match percentage and reasons before publishing;
Module 11's thresholds (0.55 offer, 0.5 business) and its recommendation-only
stance (never auto-merge) are untouched.

---

## 4. robots.txt compliance

New `RobotsService`, checked by `UrlFetchService` before every page request.

**Ordering matters and is tested:** the SSRF guard runs *first*, so a blocked
host never receives a request of any kind — not even the robots.txt lookup.
Security control first, policy check second.

**Re-checked on every redirect hop**, because a redirect can cross origins
into a site with an entirely different policy.

Implements the RFC 9309 rules that actually bite:

| Rule | Behavior |
|---|---|
| Group selection | A group naming `PairleyOfferImportBot` wins over `*`; other crawlers' groups are ignored entirely |
| Explicit empty group for us | Full permission — never falls through to a restrictive `*` group |
| Specificity | Longest matching pattern wins; Allow beats Disallow on an equal-length tie |
| Wildcards | `*` matches any run; a trailing `$` anchors the end |
| Missing robots.txt (4xx) | Allowed — the standard's explicit default |
| Server error (5xx) | **Disallowed** — RFC 9309 §2.3.1.4; the site is up and declined to say what we may read |
| Unreachable | Allowed — the page fetch will fail on its own with a truthful network error |

Cached 15 minutes per origin, so one import run doesn't re-fetch robots.txt
for each redirect hop.

Failure surfaces as reason `ROBOTS_DISALLOWED`, listed in
`KNOWN_FAILURE_REASONS` so a correct compliance refusal doesn't page anyone
via Sentry. The admin sees: *"This site's robots.txt asks us not to crawl
that page, so we haven't. Upload a poster, PDF, or screenshot of the offer
instead."*

The crawler identifies itself honestly as `PairleyOfferImportBot/1.0`, and
robots.txt matching uses the bare product token so a site owner's rule keeps
applying across our version changes.

### A finding worth recording

Smoke-tested against real sites. Instagram and Facebook **both disallow us**
in their live robots.txt:

```
BLOCK  https://www.instagram.com/p/ABC123/
       -> www.instagram.com/robots.txt disallows /p/ABC123/
BLOCK  https://www.facebook.com/somepage
       -> www.facebook.com/robots.txt disallows /somepage
ALLOW  https://github.com/anthropics
BLOCK  https://github.com/search?q=test
```

This independently confirms the proposal's §7 assessment from the platforms'
own published policy, not just from their technical login wall: **social
imports are not legitimately crawlable**, and the screenshot path is the
correct route, not a workaround. The GitHub pair also demonstrates real-world
group selection and path specificity working against a complex robots.txt.

---

## 5. API

### New
| Method | Path | Purpose |
|---|---|---|
| `PUT` | `/discovery/candidates/:id/draft` | Save edits without publishing. Body `{overrides}`, same shape as approve. |

### Changed
| Method | Path | Change |
|---|---|---|
| `PUT` | `/discovery/candidates/:id/approve` | `overrides` widened from 5 fields to the full editable candidate |
| `GET` | `/discovery/candidates/:id` | Adds `import_job` (raw extraction), `subtitle`, `required_people`, `start_date`, `end_date`, `cover_image` |

### Reused unchanged
`POST /discovery/import` · `POST /discovery/import-file` ·
`GET /discovery/jobs` · `GET /discovery/jobs/:id` ·
`GET /discovery/candidates` · `PUT /discovery/candidates/:id/reject` ·
`PUT /discovery/candidates/:id/takedown` · both bulk endpoints · the entire
claim and business-consolidation APIs.

All admin-only via `JwtAuthGuard` + `RolesGuard` + `@Roles(Role.ADMIN)`,
unchanged.

**Note on `POST /discovery/import`:** it runs the whole pipeline before
responding, so a failed import — including a robots refusal — comes back as
a `FAILED` job with **HTTP 200**, not a thrown error. The UI reads the
outcome off the returned job rather than inferring success from the request
completing.

---

## 6. Database

**No changes.** No new tables, no new columns, no migration. Every editable
field maps to a column that already existed on `Offer` or `Business`.

The two columns the proposal identified as genuinely missing
(`offers.max_people`, `offers.terms_conditions`) belong to Phase 2's
extraction work and are **not** added here — nothing extracts them yet.

---

## 7. Files

### Backend
| File | Change |
|---|---|
| `src/discovery/robots.service.ts` | **new** — parser, policy cache, decision |
| `src/discovery/robots.service.spec.ts` | **new** — 33 tests |
| `src/discovery/url-fetch.service.ts` | robots check per hop; shared UA constant |
| `src/discovery/url-fetch.service.spec.ts` | `RobotsService` injected; 5 compliance tests |
| `src/discovery/import-orchestration.service.ts` | `ROBOTS_DISALLOWED` as a known reason |
| `src/discovery/discovery.module.ts` | registers `RobotsService` |
| `src/discovery/review-queue.service.ts` | widened `CandidateOverrides`; `saveDraft()`; coherence checks; P2002 handling; `import_job` in detail |
| `src/discovery/review-queue.controller.ts` | widened DTO with validation; `PUT :id/draft` |
| `src/discovery/review-queue.service.spec.ts` | +14 tests for editing, drafts, coherence |

### Frontend
| File | Change |
|---|---|
| `src/utils/discoverySource.js` | **new** — sources, URL normalization, failure copy, confidence bands, job helpers |
| `src/utils/discoverySource.test.js` | **new** — 29 tests |
| `src/utils/candidateOverrides.js` | **new** — form → payload conversion, validation |
| `src/utils/candidateOverrides.test.js` | **new** — 23 tests |
| `src/pages/admin/AiOfferDiscoveryPanel.jsx` | **new** — the discovery screen |
| `src/pages/admin/CandidateReviewModal.jsx` | editable fields, raw extraction panel, Save Draft |
| `src/pages/admin/PosterUploadCard.jsx` | dedup — now uses the shared failure table |
| `src/pages/admin/DiscoveredOffersPanel.jsx` | refreshes the list after a draft save |
| `src/pages/admin/AdminDashboard.jsx` | new tab |

---

## 8. Test results

**Backend** — 448 passed / 449. The single failure is `app.controller.spec.ts`,
a pre-existing Nest scaffold test whose test module doesn't provide
`PrismaService`; unrelated to this module and failing before it.
Discovery suite specifically: **312/312**.

**Frontend** — **96/96** across 8 files. Production build clean, lint clean.

New coverage: robots group selection and path specificity (including the
empty-group-means-permission inversion and regex-metacharacter escaping),
5xx-means-disallow, caching per origin, SSRF-before-robots ordering,
redirect re-checking, full-field override application, draft/approve
divergence, and price/date coherence including single-sided edits.

---

## 9. Known limitations

1. **Extraction is still five fields.** Title, description, image, price, raw
   text. The review form exposes every Pairley field for editing, but
   business phone/address/GST/website arrive empty and must be typed in by
   hand until Phase 2. The form is ready for them; the pipeline isn't.
2. **Confidence is one number for the whole offer.** The High/Medium/Low band
   is real, but it is not per-field, so "highlight low-confidence fields"
   isn't possible yet — Phase 2.
3. **Category still defaults to `shopping`** on every candidate. Unchanged
   from Module 9; it's a Phase 2 classification problem.
4. **Business name is still hostname-derived** (`"specgym.in (imported)"`) or
   a generic `"Poster Import"` label. Admin-editable now, but not extracted.
5. **`POST /discovery/import` blocks for the whole pipeline** (up to ~10s).
   Acceptable for an admin action with a visible in-flight state; the file
   path is already async and the website path could match it later.
6. **Wikipedia was unreachable from the build environment**, so that specific
   robots.txt was not verified live. Instagram, Facebook, and GitHub were.
7. **No live browser verification yet** — see
   `MODULE14_PHASE1_BROWSER_VERIFICATION.md`.

---

## 10. Recommendations for Phase 2

In the order I'd do them:

1. **Extract business contact data first, not the AI classification.** Phone,
   address, website, and GST are deterministic pattern-matching against text
   the pipeline already has, they need no model call and no budget, and they
   unblock Phase 4's merchant invite entirely. This is the cheapest work with
   the largest downstream effect.
2. **Make per-field confidence part of extraction, not an afterthought.**
   Extend the existing `enrichment_metadata` shape rather than adding
   columns. The review UI already bands confidence — it just needs per-field
   numbers to point at.
3. **Then the OpenAI provider, for classification only.** Category, merchant
   type, tags, keywords — the judgement calls. Keep it behind the existing
   `EnrichmentProvider` interface and keep it advisory. Set the per-import
   and monthly cost caps before writing the provider, not after.
4. **Test the "no phone on the page" case hardest.** A plausible-looking
   hallucinated phone number is materially worse than a blank field, because
   Phase 4 would eventually message it. An empty result must stay empty.
5. **Leave `offers.max_people` and `offers.terms_conditions` until something
   extracts them.** They're the only two new columns the whole module needs;
   adding them before there's a writer just creates dead schema.

---

## 11. Status

**Phase 1 complete and approved (2026-07-29).** Tagged
`pairley-module14-phase1-complete`. Phases 2–5 not started; no further
enhancement to this module after this commit.

Verification evidence is of two kinds, and
`MODULE14_PHASE1_BROWSER_VERIFICATION.md` keeps them separate:

- **Machine-verified** — the whole import pipeline against real network and
  real files, plus role-based access control and the Edit/Save Draft/Reject
  API path against the real database. Timings and outputs recorded.
- **Product-owner sign-off** — the rendering, polling, button-state,
  responsive-UI and Approve-workflow checks. Not run by the implementer.
