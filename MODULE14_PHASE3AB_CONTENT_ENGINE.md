# Module 14 Phase 3A + 3B — Contact Protection & Pairley Content Engine

**Approved and committed 2026-07-29**, tagged
`pairley-module14-phase3ab-complete`. Phases 3C and 3D not started.

Phase 3A is best understood as a **platform-wide security improvement** that
happened to be found during Module 14 work — it protects every offer on
Pairley, including merchant-created ones, not just AI-imported listings.

---

## Phase 3A — Contact protection

### The gap that was open

`GET /offers/details/:id` uses `OptionalJwtAuthGuard` — no login required —
and returned to **anonymous** callers:

```
business.mobile   business.email   business.owner_name   business.address
```

`Offer.whatsapp_number` leaked the same way through `GET /offers/list` and
through `GET /offers/category/:category`, which has **no guard at all**.

This was every offer on Pairley, including real merchants', not just
AI-imported listings.

### The rule now enforced

**If a protected value is in the JSON, it is public.** Masking in the
frontend is presentation, not protection. So contact columns are *never
selected* for a viewer who isn't entitled to them — they don't enter the
process at all, and a later refactor can't forget to strip them.

`src/offer/offerVisibility.ts` is the single decision point:

| Viewer | Claimed business | Unclaimed business |
|---|---|---|
| Anonymous | ❌ `SIGN_UP_REQUIRED` | ❌ `SIGN_UP_REQUIRED` |
| Authenticated customer | ✅ `AVAILABLE` | ❌ `USE_OFFICIAL_WEBSITE` |
| Other merchant | ✅ `AVAILABLE` | ❌ `USE_OFFICIAL_WEBSITE` |
| Owning business / admin | ✅ always | ✅ always |

The unclaimed case is deliberate: a merchant who hasn't joined Pairley
published that number themselves, so Pairley doesn't present itself as the
gatekeeper to it. The customer is pointed at the merchant's own site, and the
merchant is invited to claim the listing to manage how customers reach them.

**Anonymous callers receive**: business name, city, state, mall/locality,
shop photo, coordinates, claim status, website — plus `contact_available` and
`contact_notice` so the UI can explain the absence without carrying the value.

**Street address and pincode are no longer public at all.** City and
mall/locality are the public location. Coordinates stay public — a
storefront's position is how customers find it, the map depends on it, and it
was already public before this change.

### Live verification

Backend booted against the real database and every public surface scanned:

| Surface | Before | After |
|---|---|---|
| `GET /offers/list` (anonymous) | leaked `whatsapp_number` | **CLEAN** |
| `GET /offers/category/:c` (unguarded) | leaked `whatsapp_number` | **CLEAN** |
| `GET /offers/details/:id` (anonymous) | leaked mobile, email, owner_name, address, whatsapp_number | **CLEAN** |

Graduated access confirmed on the same offer: anonymous →
`contact_available=false, SIGN_UP_REQUIRED`; authenticated customer on a
claimed business → `AVAILABLE` with the real number; admin → `AVAILABLE`.

### Frontend

The customer deal page never displayed merchant contact, so nothing broke.
It now renders the notice instead:

- Anonymous → *"📞 Contact available after free signup"*
- Unclaimed merchant → *"Visit official website (specgym.in)"*, or nothing at
  all when no website is known, rather than a dead button.

`normalizeWebsite()` refuses `javascript:` and `data:` URLs — the value ends
up in an `href` and originates from scraped web content.

---

## Phase 3B — Pairley Content Engine

### Copy catalog, not generated copy

`src/offer/pairleyCopyTemplates.ts` holds the approved Pairley explanation
for **every one of the 17 `OfferType` values**. Nothing here is model output.

The catalog is typed `Record<OfferType, CopyStrings>`, so adding a value to
the enum **fails the build** until its copy is written. Verified: removing an
entry produces `error TS2741`.

**The "never promise a group will form" rule is structural.** A test scans
every catalog string *and* every rendered output across all offer types and
participant counts for promise language (`we will find`, `guaranteed`,
`your group will`, `will be matched`, …). It holds because no code path can
emit a promise — not because a prompt asked a model to behave.

Copy is selected by offer type **and** participant count: `required_people > 1`
gets group wording, otherwise a solo variant where one makes sense. BOGO has
no solo variant, because it is inherently a pairing mechanic.

**Localisation-ready**: entries are strings with `{{people}}` placeholders,
not functions, so a translator works from a plain string table. Adding Tamil,
Kannada, Telugu or Hindi is a new key in `CATALOG` — no code change.

`{{people}}` interpolates to the **number only**; each template supplies its
own noun (`{{people}} customers`, `{{people}} members`). That matters for
translation, where noun placement differs per language.

### Banner engine — composed, not generated

`bannerLayout.ts` (pure, testable) decides everything; `banner-render.service.ts`
turns it into pixels via `sharp` compositing an SVG over an optional hero image.

**No image-generation model.** A banner is a layout with ~10 text fields;
image models render text unreliably. Composition gives exact text, identical
branding, no per-image cost, and **66–128ms** renders — fast enough to
regenerate on an admin edit.

Per-banner: category-tinted plate, badge, discount chip, business name,
location, title, Pairley headline, Pairley explanation, price, struck-through
original, savings, group-size chip, CTA, Pairley branding, offer type.

**Badge vocabulary** — `is_pairley_exclusive` is *ignored on imported offers*,
so an admin cannot accidentally publish a false exclusivity claim on a scraped
listing:

| Badge | When |
|---|---|
| Verified by Pairley | `merchant_verified` |
| Pairley Exclusive | only for `source = MANUAL` |
| Claimed Business | business has claimed its listing |
| Discovered on Pairley | any imported offer |
| Pairley Curated | otherwise |

**Merchant logos are withheld until a business claims its listing.** A logo is
a trademark; compositing it into a Pairley-branded banner would imply an
endorsement that doesn't exist. The business name renders as text instead.

**Honest pricing.** `computeDiscountPercent` returns null — and the banner
omits the chip entirely — when the original price is zero or absent, the offer
price is higher, or the discount rounds to 0%. No banner ever claims a
discount that isn't real.

**Hostile input is escaped.** Business names come from scraped pages; every
string reaching the SVG passes through `escapeXml`, with a test asserting no
raw angle bracket survives into any text field.

**A missing photo never blocks a banner.** Hero fetch failures fall back to
the category plate.

### Three bugs found by rendering banners and looking at them

Unit tests passed throughout; these were only visible in the output:

1. **`"once 12 people customers have shown interest"`** — `{{people}}`
   expanded to `"12 people"` while templates already supplied a noun. Fixed to
   emit the number only; a regression test now scans every type and count for
   a doubled noun.
2. **Horizontal overflow** — long titles and body copy ran off the canvas.
   Character counts were guessed. Now computed from available width via
   `charsThatFit()`, sized against a monospace advance because the container
   may not have a proportional font installed.
3. **Vertical collision** — a two-line title pushed the body into the price
   block. The body line count is now derived from the space actually left.

---

## Files

**Backend**: `offerVisibility.ts` + spec (new), `pairleyCopyTemplates.ts` +
spec (new), `bannerLayout.ts` + spec (new), `banner-render.service.ts` (new),
`offer.service.ts`, `offer.module.ts`, `offer.service.leadFlow.spec.ts`.

**Frontend**: `merchantContact.js` + test (new), `DealDetailPage.jsx`,
`DealDetailPage.css`.

## Database

**No changes.** No new tables, no new columns, no migration.

## Tests

Backend **532/533** (the one failure is the pre-existing `app.controller.spec.ts`
scaffold test, unrelated). Offer suites specifically **97/97**.
Frontend **110/110**. Build and lint clean.

## Regression tests retained

Each bug above is now pinned by a test that fails if it returns:

| Bug | Test | Where |
|---|---|---|
| Doubled noun after the count | `never doubles the noun after the participant count` — scans every offer type × {2, 5, 12} for `\d+ (people\|customers\|members) (people\|customers\|members)` | `pairleyCopyTemplates.spec.ts` |
| Count rendered without a noun | `always states the count with a noun, never as a bare number` | `pairleyCopyTemplates.spec.ts` |
| Horizontal overflow | `never emits a line longer than the limit` — asserts across three line widths | `bannerLayout.spec.ts` |
| Line-count blowout | `respects the maximum line count`, `marks the final line when content was dropped` | `bannerLayout.spec.ts` |
| Unbreakable long word overflowing | `hard-splits a single word longer than the line` | `bannerLayout.spec.ts` |

Vertical collision is prevented structurally rather than by assertion: the
body line count is derived from the space remaining above the price block
(`PRICE_BASELINE_OFFSET`, `BODY_PRICE_GAP`), so it cannot be exceeded.

Alongside these, the standing structural guarantees are:

- **No promise language** — every catalog string *and* every rendered output,
  across all 17 offer types × 4 participant counts, scanned against ten
  promise patterns.
- **No unescaped markup** — no raw `<` or `>` may survive into any banner
  text field.
- **No false discount** — six cases where a discount must be suppressed.
- **No contact leak** — the public projections are asserted not to contain
  `mobile`, `email`, `owner_name`, `address`, `whatsapp`, `support_number`,
  `whatsapp_number`, and the public/contact projections are asserted never to
  overlap.

---

## Phase 3C — approved scope (not started)

Recorded here so the next session doesn't have to reconstruct it:

1. Persist generated banners to the existing `Offer.generated_offer_card`
   column (no schema change needed).
2. Hero image selection and ranking — official banner → offer image → hero →
   product → interior → logo.
3. Banner preview, regeneration, and manual image replacement.
4. **Admin template selection** across a small template library:
   Template A large hero + big discount badge + bottom CTA; Template B split
   layout (left image, right details); Template C premium card for
   restaurants/hotels; Template D gym/fitness; Template E retail/electronics.
   Consistent Pairley branding across all of them.
5. **Embedded font** — bundle an open-source face with the application rather
   than relying on the runtime environment. Candidates agreed: Inter, Outfit,
   Noto Sans, Manrope. This removes the monospace-fallback constraint that
   currently forces conservative text sizing (see Known limitations).
6. Final publish preview.

Phase 3D (later, unapproved): multi-offer detection, business-level grouping,
batch banner generation, individual approval/publishing, merchant onboarding
from discovered businesses.

## Known limitations

1. **Banners aren't persisted or wired to an offer yet.** `BannerRenderService`
   renders on demand; storing to `Offer.generated_offer_card` (the column
   already exists) and the admin regenerate/preview flow are Phase 3C.
2. **Font dependence.** `font-family="sans-serif"` resolves to whatever the
   container has. Layout is sized for the widest (monospace) case so text
   never overflows, but it will look tighter and better with a proportional
   font installed. Bundling one is worth doing before banners go customer-facing.
3. **Category background plates are flat gradients.** Good enough and
   on-brand; per-category illustration is a later refinement.
4. **Hero image selection isn't implemented** — `heroImageUrl` is an input the
   caller supplies. The ranking logic (official banner → offer image → hero →
   product → interior) is Phase 3C.
5. **No browser verification** of the deal-page contact notices.
