# Module 14 — Template F "Cost-Split" Banner

**Status: implemented, unit-verified, and visually verified against a
rendered reference match. Not committed.** An addition to the existing
Phase 3C Banner Studio, built at explicit "full priority now" direction —
not a new phase, and it doesn't change Phase 3C's own outstanding items
(Render font verification, browser verification, AWS S3 quarantine — all
still open, and Template F is subject to every one of them too).

---

## What this is

A sixth banner template matching the reference design supplied: a numeric
"How You Save" box (Actual Price / You Pay / You Save, closing on the
group's combined saving), a 3-step unlock diagram, an Offer Partner card,
Why-Pairley trust bullets, and a bottom CTA bar with a QR code linking to
the real deal page.

Added as its own template (`F`) rather than reshaping an existing one, per
your direction — it only earns a strong recommendation when there's a
genuine group saving to show; otherwise the existing five templates still
win.

## Reference match

Rendered against the exact numbers from your reference image (₹698 → ₹349)
to confirm the arithmetic and layout — see §5 for the rendered result and
the fixes that got it there.

---

## 1. Content — deterministic, never fabricated

New file `costSplitBanner.ts`, same discipline as `pairleyCopyTemplates.ts`:
every string is a pure function of structured fields, reviewed once, never
model output.

### The savings box

`computeCostSplit(originalPrice, offerPrice, requiredPeople)` returns the
box content, or **`null`** when there's nothing honest to show.

**Price semantics — the thing this box has to get right.** Across the
platform `original_price` and `offer_price` are both *per person*: the
customer-facing `DealCard` renders `offer_price` as the price,
`original_price` struck through, and the difference as "Save ₹X". The box
states those same three quantities, so a customer comparing the banner
against the deal page sees matching numbers. It then closes on the group's
combined saving — group size × per-person saving — and prints that
multiplication (`"50 × ₹5,000"`) on the banner so the headline figure stays
checkable rather than merely asserted.

It deliberately does **not** present a "you pay half, your partner pays the
other half" split. That framing is only correct at exactly 50% off with
exactly 2 people, and was shipping wrong numbers on every other offer —
see §5, "The bug the reference case was hiding".

Withheld entirely when a figure would be fabricated or degenerate:

- no genuine price pair, or the offer price isn't actually lower
- fewer than 2 people required (no group, so no group saving)
- the saving is a rounding-error sliver (e.g. ₹990 vs ₹1,000 — a 1%
  discount belongs on the ordinary discount chip)
- the remaining price is a sliver, which means the prices are bad data

Wording adapts to group size: `"You Both Save"` for a pair, `"You All
Save"` for larger groups — `"Both"` is only grammatically correct for two.

### The 3-step unlock diagram

Fixed, not per-offer. Step 2 follows the same load-bearing rule as the
Pairley copy catalog — states the *condition* ("when N people show
interest…"), never promises the group completes. Tested against the same
forbidden-phrase list used for the main copy catalog.

### Why-Pairley bullets

Three brand-level bullets always shown. **"Verified Local Partner" is
withheld for an unclaimed business** — claiming a trust relationship with a
merchant who hasn't joined Pairley yet would be exactly the overclaim
Phase 3B's badge rules already refuse to make (the same reasoning that
keeps `EXCLUSIVE` off imported offers).

### The QR code

Encodes `{PAIRLEY_WEB_URL or https://pairley.com}/deals/{offerId}` — matches
the frontend's real `DEAL_DETAIL: '/deals/:id'` route, checked in
`constants.js` before hardcoding it. Returns `null` without an offer id,
never a broken link. `PAIRLEY_WEB_URL` is a new optional env var for
pointing at staging without a code change.

### The rating

**A genuine aggregate from the existing (previously unused) `Rating`
table**, not a fabricated number. `BannerService.getBusinessRating()` runs
`prisma.rating.aggregate()` and returns `null` for a business with zero
reviews — the common case for a freshly AI-discovered, unclaimed business.
The reference image's "4.6 ⭐ (1.2K+ Reviews)" is real data when it exists,
and simply absent from the banner when it doesn't, never invented.

## 2. Layout

`banner-render.service.ts` gains `renderCostSplit()` and
`buildCostSplitSvg()`, kept separate from the A-E `buildSvg()` rather than
threaded through it — the two layouts don't share enough structure to make
one function honest about both.

**Landscape canvas (1200×900)**, not the shared 1080×1080 square — matches
the reference's proportions rather than force-fitting rich horizontal
content into a square. `BannerLayout` now carries per-template dimensions
(`TEMPLATE_DIMENSIONS`), A-E unchanged at 1080×1080.

**The hero photo is a small inset panel**, not a full-bleed background like
A-E — composited via an embedded base64 `<image>` inside the SVG (verified
separately that librsvg actually rasterises this, and `clipPath` roundings,
before building on top of the assumption — same caution that caught the
`@font-face` dead end in Phase 3C).

## 3. New dependency

`qrcode` (+ `@types/qrcode`) — a real, widely-used MIT package, needed for
an actual requirement. Verified the exact embedding technique (QR PNG →
base64 → SVG `<image>` → sharp rasterisation) before writing the full
integration.

## 4. Recommendation wiring

`recommendTemplate()` gains `costSplitEligible: boolean`, computed by
`BannerService` from **the same `isCostSplitEligible()` function the
renderer itself uses** — so "Template F is recommended" and "its math box
would actually have content" can never disagree. Scored +26 when eligible,
−35 when not, so F only wins when there's real content for it to show.

**No frontend changes needed.** `BannerStudioModal.jsx` already renders
whatever `templates` the preview API returns (`templates.map(...)`, no
hardcoded count) — Template F appears in the admin's picker automatically.

## 5. Five real bugs, found by rendering and looking

Every one of these passed all unit tests and was only visible in the
rendered PNG — same pattern as every prior round of this module.

| # | Bug | Fix |
|---|---|---|
| 1 | Discount badge's 3rd line of text had no usable width near the circle's edge and overflowed straight through the Offer Partner card below it | Cut to 2 lines, shrank and repositioned the circle |
| 2 | Offer-type badge ("GROUP DISCOUNT DEAL", "FLAT DISCOUNT DEAL") clipped on both edges — fixed 180px width, no dynamic sizing | Dynamic width from text length, same approach A-E's badge already used |
| 3 | Why-Pairley bullets' second row collided with the horizontal divider line above the 3-step diagram | `stepsTop` now computed from the actual bullets-block height, not a hardcoded floor |
| 4 | Large dead space above the steps section when an offer has no cost-split box | Same fix as #3 — `stepsTop` driven by real content height on both columns |
| 5 | **"You Both Enjoy for Only" shown even for a 5-person group split** — grammatically wrong, and the exact kind of content-accuracy bug this module's discipline exists to catch | Added `enjoyLabel` to `CostSplit` ("You Both Enjoy" for 2, "You All Enjoy" for more), wired the renderer to use it instead of hardcoded text |

Bug 5 is worth flagging on its own: the underlying logic
(`computeCostSplit`) was correct and fully tested from the start — the bug
was that the **renderer** had its own hardcoded copy of the phrase instead
of reading the computed field. A reminder that unit tests on pure logic
don't catch a renderer that ignores the logic and hardcodes something else;
only looking at the rendered output does.

All five confirmed fixed by re-rendering the same four test cases
afterward.

### The bug the reference case was hiding

Found later, rendering Template F against **live production offers** rather
than the reference numbers. Two separate content bugs, both with the same
shape: *self-consistent at exactly 50% off, wrong everywhere else.* The
reference image (₹698 → ₹349, 2 people) is a 50%/2-person case, and every
BOGO row in the database is too — so both bugs read perfectly on every
example anyone had looked at.

**1. The savings box asserted figures that were not true.** It read
`original − offer` as "what the other participants pay between them". That
quantity is the *per-person saving* — `DealCard` shows the identical number
to customers as "Save ₹X". On the live `₹10,000 → ₹5,000, 50 people` offer
the box claimed the other 49 people pay ₹5,000 between them, when they pay
₹245,000. Worse, its "total" was `original`, so the banner struck through
₹10,000 and then celebrated **"You All Enjoy for Only ₹10,000 Together!"** —
arguing to the customer that the deal saves nothing.

| Live offer | Box used to say | Truth |
|---|---|---|
| BOGO ₹2,400 → ₹1,200, 2 people | others pay ₹1,200; total ₹2,400 | correct — the 50%/2 coincidence |
| GROUP ₹10,000 → ₹5,000, 50 people | 49 others pay ₹5,000; total ₹10,000 | 49 × ₹5,000 = ₹245,000 |
| GROUP ₹10,000 → ₹8,000, 10 people | 9 others pay ₹2,000; total ₹10,000 | 9 × ₹8,000 = ₹72,000 |

Fixed by restating the box in the platform's own per-person terms — Actual
Price / You Pay / You Save, closing on group size × per-person saving, with
the multiplication printed alongside it.

**2. The hero badge inverted its own claim.** The caption read `YOU PAY
ONLY` above a *discount* percentage, so the 20%-off offer announced **"YOU
PAY ONLY 20%"** when the customer pays 80%. The caption now reads `YOU SAVE`
and lives in `buildDiscountBadgeText()` alongside the other Template F copy,
so the caption and the figure can't drift apart again — it was a bare
literal inside the SVG string, which is exactly why nothing could assert on
it. Templates A–E were checked and are unaffected: they render the raw
`"20% OFF"` chip, which carries its own unit.

Both were invisible to the test suite — the arithmetic was tested against
the reference numbers, where it agreed. What caught them was rendering
Template F against real rows from the production database and reading the
sentences the banner actually made.

## 6. Tests

| Suite | Count |
|---|---|
| `costSplitBanner.spec.ts` (new) | 26 |
| `bannerTemplates.spec.ts` (+ Template F cases) | 31 |
| `bannerLayout.spec.ts` (+ Template F integration) | 51 |
| `banner.service.spec.ts` (+ costSplitEligible, rating, branding wiring) | 26 |
| `banner.controller.spec.ts` | 14 |
| `bannerBranding.spec.ts` | 23 |
| **Offer module** | **302, all passing** |
| **Backend total** | **738, 737 passing** (1 pre-existing, unrelated scaffold failure) |

The one failure is `app.controller.spec.ts`: the Nest CLI scaffold test
builds a bare module with only `AppService`, while `AppController` has since
gained `PrismaService` and `SystemHealthService`. It fails independently of
this work.

The branding-wiring tests were mutation-checked rather than trusted for
passing on the first run — reverting the service to ignore the stored
preference fails exactly one test, confirming the assertion is load-bearing.

Build clean. Lint clean on every file touched, aside from the same
pre-existing `expect.objectContaining` nested-type-inference false positive
already present project-wide (6 instances, unchanged — the new tests add
none).

## 7. Files

**New**: `costSplitBanner.ts` / spec.

**Changed**: `bannerLayout.ts` / spec (per-template dimensions, Template F
content fields), `bannerTemplates.ts` / spec (Template F definition,
`costSplitEligible` scoring), `banner-render.service.ts` (renderer),
`banner.service.ts` / spec (`costSplitEligible` + rating wiring),
`package.json` (`qrcode`, `@types/qrcode`).

**Frontend**: none.

**Database**: none — the `Rating` table already existed and was unused.

## 8. What's still outstanding

Unchanged from Phase 3C, and Template F is subject to all three:

1. **Render font verification** — Template F is, if anything, more
   typography-dependent than A-E (more text blocks, smaller sizes for the
   cost-split box and steps). Same standing plan: verify on Render, not
   Windows.
2. **Browser verification** — no automation available here.
3. **AWS S3 quarantine** — blocks own-storage hero images the same way it
   does for A-E; Template F's inset hero panel hits the identical
   `getFileByUrl` path already fixed and documented in
   `MODULE14_PHASE3C_BANNER_STUDIO.md` §2.
