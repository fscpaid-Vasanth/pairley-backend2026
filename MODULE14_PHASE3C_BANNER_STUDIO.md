# Module 14 Phase 3C — Banner Studio (Persistence, Preview, Admin Workflow)

**Status: implemented, unit- and live-verified at the service/API layer. Not
committed. Render font verification and browser verification are explicitly
outstanding — both require the user, per the agreed plan.**

This phase turns the Phase 3B decision engine (hero ranking, template
recommendation, banner composition) into the complete admin workflow: import
→ generate → store → preview → template-switch / image-replace → regenerate
→ publish, with an append-only version history and rollback.

---

## 1. What was built

### Image Analysis Service — real measurements, not placeholders

`ImageAnalysisService` probes an image with `sharp` and reports:

| Metric | Method | Verified |
|---|---|---|
| Width / height / aspect / orientation | `sharp().metadata()` | ✅ exact values, tested against real generated PNGs |
| Brightness / contrast | Channel mean/stdev, normalised | ✅ dark (0.005) vs bright (1.0), flat vs checkerboard |
| **Blur / sharpness** | Variance-of-Laplacian (a real edge-response measure, not a heuristic) | ✅ sharp image scores measurably higher than the same image blurred |
| Dominant colour | `sharp().stats().dominant` | ✅ hex output |
| File size / format | Buffer length / `metadata().format` | ✅ |

**Watermark detection is not attempted.** Per the Phase 3B finding (two
region-statistics approaches tried and measured, both insufficient — see
`ImageAnalysisService.WATERMARK_DETECTION_STATUS`), `watermarkConfidence` is
always `null`. This phase's decision, per your instruction: keep
`watermarkSuspected` as a **manual, tri-state, admin-only signal**:

- `null`/absent — not assessed. No effect on ranking.
- `true` — admin flagged it. Penalised (−30, same as before).
- `false` — admin explicitly confirmed clean. **No effect on ranking** —
  absence of a problem isn't a quality signal, but it's preserved so the UI
  can show "checked" rather than "unknown".

The ranking engine never sets this itself. Tested: null, undefined, and
`false` all score identically to an unflagged candidate; only `true`
penalises; a confirmed-clean flag never forces `needsReview`.

### Image Suitability Score — the requested enhancement

A transparent 0–100 score, independent of role, so an admin can compare two
images of the same role without needing to understand the internal ranking
math:

| Component | Weight | Basis |
|---|---|---|
| Resolution | 0–30 | Width vs. the template's minimum, tapered |
| Sharpness | 0–25 | The same blur measurement used elsewhere |
| Exposure | 0–20 | Brightness/contrast, judged for overlaid-text legibility |
| Aspect fit | 0–15 | How much crop the template would need |
| Orientation match | 0–10 | Landscape/portrait/square bucket match |

Always sums to the reported total (tested). `watermarkSuspected` is
deliberately excluded — it's an editorial call, not a measured quality
dimension.

### Banner Persistence — `generated_offer_card`, reused audit trail

`BannerService` is the only writer of `Offer.generated_offer_card`. Every
render call writes it; a page load reads it — **no recomputation on read**.

Version history reuses the existing **append-only `OfferVersion` table**
rather than a new one, per your decision: it already carries a JSON
snapshot, the acting admin, and a change type. Four change types:
`BANNER_GENERATED`, `BANNER_TEMPLATE_CHANGED`, `BANNER_IMAGE_REPLACED`,
`BANNER_REGENERATED`. Rollback **adds** a new `BANNER_REGENERATED` row
pointing at an earlier snapshot's image — it never deletes history.

**No new tables. No new columns.**

### Regeneration reuses stored data — no re-crawl, no re-OCR, no re-extraction

`regenerate()` reads the current `Offer` row and the current banner version;
it never touches `UrlFetchService`, `OcrService`, or any extraction service.
Verified both structurally (no import of any discovery-module service in
`banner.service.ts`) and by test (`'reuses the stored structured data —
never touches OCR, crawling or extraction'`).

### API — thin, decision engine stays independent

| Method | Path | Purpose |
|---|---|---|
| `GET` | `.../banner/preview` | Everything the studio needs: current banner, versions, template recommendation + scores, ranked images |
| `GET` | `.../banner/images` | Image ranking alone |
| `POST` | `.../banner/images/rank` | Re-rank against a set of manual watermark flags, without generating |
| `GET` | `.../banner/template-recommendation` | Recommendation alone |
| `GET` | `.../banner/versions` | Full history |
| `POST` | `.../banner` | First generation, or explicit re-render with options |
| `PUT` | `.../banner/regenerate` | Rebuild only — carries current template/hero forward unless overridden |
| `PUT` | `.../banner/hero` | Select an already-detected image as hero (overrides ranking) |
| `POST` | `.../banner/hero-upload` | Upload a replacement image (magic-byte validated, same as Module 10) and rebuild with it |
| `PUT` | `.../banner/rollback` | Re-point at an earlier version; adds a new append-only row |

All admin-only, all under `/discovery/candidates/:id/banner`. Every handler
is a thin pass-through to `BannerService` — none of the ranking/
recommendation/scoring logic lives in the controller.

### Admin UI — Banner Studio

New "🎨 Design Banner" button on `CandidateReviewModal`, opening
`BannerStudioModal`: current banner vs. no-banner state, one-click
generate/regenerate, template picker (5 cards, recommended one badged, with
its reasons), quality-ranked image picker (suitability score, dimensions,
review-needed reasons, tri-state watermark toggle cycling
not-assessed → flagged → confirmed-clean), manual image upload, and a
collapsible version history panel with per-version rollback.

Generated banners and hero-candidate thumbnails are routed through the
existing `document-preview` proxy (`getDocumentPreviewUrl`), same as every
other S3-backed image in the admin dashboard — necessary because the bucket
has no public read access (see §3).

---

## 2. A real bug found and fixed during live verification

**Uploading a replacement hero image, then generating, produced a banner
with `usedHeroImage: false`** — the upload succeeded, but the render fell
back to the gradient plate as if no image existed.

Root cause: `BannerRenderService.loadHero()` used a plain, unauthenticated
`fetch()` for every hero URL. That works for a merchant's own public
website, but **our own S3-stored images require an authenticated read** —
exactly the same reason the admin `document-preview` proxy exists for KYC/
poster/PDF/claim-evidence previews. `loadHero()` was the one image-reading
path in the codebase that didn't route through it.

**Fix:** `BannerRenderService` now takes a `StorageService` dependency and
classifies the hero URL by hostname (`.amazonaws.com` /
`firebasestorage.googleapis.com` → `storage.getFileByUrl()`; anything else →
plain `fetch()`), mirroring the frontend's own `isS3Url()` distinction in
`adminFilePreview.js`. Pinned by 10 new tests, including the exact
regression case (an S3 URL must call `getFileByUrl`, never `fetch`).

**This fix is confirmed correct but not confirmed end-to-end**, because
fixing the routing surfaced the **same pre-existing `AWSCompromisedKeyQuarantineV3`
quarantine** that has blocked every document-preview surface since Module 1
(support case `178454777500456`). The authenticated read now correctly
*reaches* AWS and gets a real, specific denial:

```
User: arn:aws:iam::744574782789:user/pairley-backend is not authorized to
perform: s3:GetObject on resource: "...banners/..." with an explicit deny
in an identity-based policy: arn:aws:iam::aws:policy/AWSCompromisedKeyQuarantineV3
```

Nothing further is needed code-side. Once the quarantine clears, own-storage
hero images (an admin's upload, or a Module 10 poster/PDF's cover image)
will render correctly with zero additional changes — the same is true for
every other blocked preview surface.

**Externally-hosted hero images are unaffected** — verified live: a
GitHub-hosted PNG was probed, scored, selected, and composited into a real
banner (`usedHeroImage: true`) end to end.

---

## 3. Live verification (real server, real database, real network)

Every claim below was run against the actual backend and Neon database, not
mocked. Test data was rejected (never published) and cleaned up after.

| Step | Result |
|---|---|
| All 10 banner routes registered | ✅ |
| `GET preview` on a fresh offer (no images yet) | ✅ `current: null`, sensible defaults |
| `GET preview` with a reachable image (GitHub asset) | ✅ probed: 560×560, brightness 0.778, contrast 0.391, sharpness 1.0, suitability 75/100 |
| `POST generate` | ✅ 201, banner uploaded to S3, version 3 recorded |
| `PUT regenerate` with a different template | ✅ `BANNER_TEMPLATE_CHANGED` recorded |
| `PUT hero` with a manual image override | ✅ `BANNER_IMAGE_REPLACED` recorded, `heroManual: true` |
| `GET versions` | ✅ full, correctly-typed history |
| `PUT rollback` to an earlier version | ✅ **adds** a new `BANNER_REGENERATED` row; history stays 4 rows deep, nothing deleted |
| `POST hero-upload` (real multipart PNG) | ✅ 201, `probe.ok: true`, `probe.width/height` correct |
| `POST hero-upload` with a fake/corrupt file | ✅ rejected before reaching the render pipeline |
| `POST images/rank` with a manual watermark flag | ✅ re-ranked, `"Possible watermark"` appears in reasons |
| Generate with an own-storage hero image | ⚠️ correctly *attempts* the authenticated read; blocked by the pre-existing AWS quarantine (§2) |
| Generate with an external hero image | ✅ `usedHeroImage: true`, real composite |

**Environment note:** `picsum.photos` was unreachable from this dev
machine (`fetch failed` at the network level) — the same class of outbound
restriction hit with Wikipedia during Module 14 Phase 1. Not a code issue;
worked around by using a reachable host (GitHub's asset CDN) for the
positive verification.

---

## 4. Tests

| Suite | Count |
|---|---|
| `heroImageRanking.spec.ts` | 41 (was 29 — +12 for suitability score and tri-state watermark) |
| `bannerTemplates.spec.ts` | 25 |
| `image-analysis.service.spec.ts` | 24 — real `sharp` measurements throughout, only the network fetch is mocked |
| `banner.service.spec.ts` | 20 |
| `banner.controller.spec.ts` | 12 |
| `banner-render.service.spec.ts` | 10 — includes the storage-routing regression test |
| **Backend total** | **665, 664 passing** (1 pre-existing, unrelated `app.controller.spec.ts` scaffold failure) |
| **Frontend** | **130/130** (+20 for `bannerStudio.js` helpers) |

Build and lint clean on both repos.

---

## 5. Files

**Backend — new**: `heroImageRanking.ts`/spec (extended), `bannerTemplates.ts`/spec
(extended), `image-analysis.service.ts`/spec, `banner.service.ts`/spec,
`banner.controller.ts`/spec, `banner-render.service.spec.ts` (new spec for
existing file).

**Backend — changed**: `banner-render.service.ts` (storage-routing fix),
`offer.module.ts` (registrations).

**Frontend — new**: `BannerStudioModal.jsx`, `bannerStudio.js`/test.

**Frontend — changed**: `CandidateReviewModal.jsx` (Design Banner button +
modal wiring).

**Database**: no changes.

---

## 6. What's genuinely outstanding

Per your commit criteria, in order:

1. **Render font verification** — cannot be done from here (needs a
   deployment). Standing item from Phase 3B/C planning; unrelated to
   anything built this round.
2. **Browser verification** — no browser automation available in this
   environment. Everything above was verified at the service/API layer
   against the real backend and database, which is strong evidence the
   logic is correct, but rendering, click-through, and the Admin UI's visual
   behaviour have not been seen in an actual browser.
3. **AWS S3 quarantine** — pre-existing, external, blocks final
   confirmation of own-storage hero images specifically (§2). Action needed
   from you, not from further code changes.

Nothing else from the commit criteria list is outstanding — hero ranking,
image analysis, template recommendation, persistence, preview/regeneration/
manual-replacement APIs, and admin UI integration are all built, tested, and
live-verified to the extent possible without a browser.

## 7. Additions made after this document

Phase 3C was extended twice at your direction. Both are subject to the
outstanding items in §6, and both are documented separately:

| Addition | Document |
|---|---|
| Template F "Cost-Split" — a sixth banner template, plus two production price-calculation corrections found by rendering against live data | `MODULE14_TEMPLATE_F_COST_SPLIT.md` |
| Merchant Branding Preference (Mode A Pairley / Mode B merchant), schema applied to production 2026-07-30, and the strengthened Template F recommendation | `MODULE14_MERCHANT_BRANDING.md` |

One finding from that work is **not** a Phase 3C item and is deliberately
deferred: merchants enter prices inconsistently (per-person vs group total),
which affects every downstream feature and is an input-quality problem
rather than a banner problem. Scoped in
`MODULE15_MERCHANT_OFFER_VALIDATION.md`.
