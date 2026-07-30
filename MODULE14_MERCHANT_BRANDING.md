# Module 14 — Merchant Branding Preference (Mode A / Mode B)

**Status: implemented, unit-verified, and visually verified across four
rendered branding cases. Not committed.** The final addition to Phase 3C,
built at your direction before Phase 3C is considered complete. It does not
change Phase 3C's own outstanding items — Render font verification, browser
verification and the AWS S3 quarantine are all still open, and this
addition is subject to every one of them too.

---

## 1. What it does

Every banner is rendered in one of two branding modes:

| | Mode A — **Pairley** (default) | Mode B — **Merchant** |
|---|---|---|
| Hero emphasis | `standard` | `elevated` — photo panel given more of the canvas |
| Logo prominence | `standard` (claimed) / `none` (unclaimed) | `prominent` — real slot in the Offer Partner card |
| Primary colour | Pairley purple | the merchant's `brand_color` |
| CTA styling | Pairley green CTA on purple bar | CTA in the merchant's colour, text auto-contrasted |

Stored per business, previewable per render.

## 2. Schema

```prisma
enum BannerBrandingMode { PAIRLEY  MERCHANT }

// on Business
banner_branding_mode BannerBrandingMode @default(PAIRLEY)
brand_color          String?
```

Applied to production on **2026-07-30** via `prisma db push` — the project's
real sync mechanism — with no `--accept-data-loss` flag required. Both
columns are additive: the enum is NOT NULL with a `PAIRLEY` default and
`brand_color` is nullable, so no existing row needed a value.

Verified immediately after applying:

```
businesses: 17 | defaulted to PAIRLEY: 17 | with brand_color: 0
```

All 17 businesses kept Pairley branding; zero rows altered. Documented in
`prisma/migrations/20260730000000_module14_phase3c_banner_branding/`.

**Why PAIRLEY is the default:** a merchant who has not explicitly chosen
otherwise has not asked for their branding to lead on a Pairley-published
banner.

## 3. Merchant branding is refused, not half-applied

`resolveBranding()` in `bannerBranding.ts` grants Mode B only when **all**
of these hold:

1. Mode B was actually requested (stored preference or an explicit preview), and
2. the business is `CLAIMED`, and
3. it has a valid brand colour.

Otherwise it returns Pairley branding together with a `downgradeReason`
naming which condition failed — the admin sees *why*, rather than
silently getting the wrong banner.

Condition 2 is the same principle that already withholds an unclaimed
merchant's logo and the "Verified Local Partner" bullet: a business that
hasn't joined Pairley never asked to be branded on it. An unclaimed
business's logo is withheld in **both** modes.

### `brand_color` is treated as untrusted input

It reaches an SVG `fill` attribute, so `normalizeHexColor()` accepts only
`#RGB` / `#RRGGBB` and rejects everything else outright rather than
attempting to sanitise it — including `red" onload="alert(1)` and
`#fff" /><script>alert(1)</script>`. A colour has exactly one legal shape,
so anything else is a rejection, not a repair. A rejected colour downgrades
the whole render to Pairley branding rather than producing a
half-merchant-branded banner.

## 4. Contrast is computed, not assumed

Two separate WCAG-relative-luminance helpers, because a colour that works
as a solid fill can be illegible as text:

- `readableTextOn(hex)` — picks near-black or white for text placed **on**
  the brand colour (the CTA button).
- `readableOnLight(hex)` — darkens the brand colour until it clears
  contrast against a **white card**, for text set **in** the brand colour.

The second exists because of a real rendered bug: a pale merchant yellow
made the headline, the price figure and the merchant name nearly invisible
on the white Template F card. Tested to terminate on pure white rather
than looping.

## 5. Preview without changing the merchant's preference

`brandingMode` on the generate / regenerate DTOs previews a mode for one
render only. The Banner Studio exposes it as a three-way toggle —
*Merchant's choice* / *Pairley* / *Merchant* — labelled **"Previewing only
— this does not change the merchant's saved preference."** Unrecognised
values fall through to the stored preference rather than erroring.

## 6. Four more bugs found by rendering and looking

All four passed the unit suite and were visible only in the rendered PNG.

| # | Bug | Fix |
|---|---|---|
| 1 | 3-step diagram clipped underneath the CTA bar in merchant mode — the elevated hero pushed content down with nothing recomputing the space left | Step body line count derived from remaining space, not a fixed 2 |
| 2 | "THE MORE WE UNLOCK!" rendered teal-on-teal — invisible — when the merchant colour was close to the CTA bar's accent | Added `onPrimaryDarkAccentColor`, resolved against the actual bar colour |
| 3 | Divider cut straight through the Why-Pairley bullets once they were clamped | `dividerY = Math.max(stepsTop - 24, bulletsBottom + 8)` — the divider can no longer land above the content it separates |
| 4 | Pale brand colour illegible as text on the white card | `readableOnLight()` (§4) |

Confirmed fixed by re-rendering in Pairley mode, merchant teal, merchant
pale-yellow, and Template A merchant mode.

## 7. Template F recommendation strengthened

Template F is now *preferred* — not merely eligible — when all three hold:
required participants ≥ 2, a valid cost split exists, and the price
reduction is visually compelling (`COMPELLING_DISCOUNT_PERCENT = 25`).

Three-tier scoring, so the strong case wins outright without F hijacking
offers it doesn't suit:

```ts
if (costSplitEligible && isGroupOffer && isCompellingSaving) score += 42; // "savings story leads"
else if (costSplitEligible && isGroupOffer)                  score += 20;
else                                                          score -= 35;
```

Verified against a live production offer, which selected F with the reason
*"50% off split across 50 people — the savings story leads."*

## 8. Tests

`bannerBranding.spec.ts` — 23 tests covering colour validation and
rejection, both contrast helpers, every downgrade path, logo prominence in
both modes, and a totality check that every returned colour is a valid hex
for any input including junk.

Wiring is covered separately, in `banner.service.spec.ts` (the stored
preference is read; an explicit preview overrides it for that render only)
and `banner.controller.spec.ts` (the mode is forwarded on both generate and
regenerate, and omitted entirely when the admin hasn't touched the toggle,
so an untouched toggle can't silently override the merchant's choice).

Those wiring tests passed on their first run, so they were mutation-checked
rather than trusted: reverting the service to ignore the stored preference
fails exactly one test, confirming the assertion is load-bearing.

Offer suite **302 passing**. Backend **737 of 738** — the single failure is
`app.controller.spec.ts`, a pre-existing Nest scaffold test that builds a
bare module with only `AppService` while `AppController` has since gained
`PrismaService` and `SystemHealthService`. Unrelated to this work and
failing before it.

Lint clean on every file touched here.

## 9. Files

**New**: `bannerBranding.ts` / `.spec.ts`,
`prisma/migrations/20260730000000_module14_phase3c_banner_branding/`

**Changed**: `schema.prisma`, `bannerLayout.ts`, `banner-render.service.ts`,
`banner.service.ts`, `banner.controller.ts`, `bannerTemplates.ts`,
`BannerStudioModal.jsx`

## 10. Still outstanding before Phase 3C can be committed

Unchanged by this addition, and this addition is subject to all of them:

- [ ] Render font verification (only weight 900 currently resolves)
- [ ] End-to-end browser verification of the complete admin workflow
- [ ] Image upload path re-verified once the AWS S3 quarantine is lifted
      (support case `178454777500456`)
- [x] Documentation
