# Pairley AI Marketplace Content Engine — Proposal (STEP 1)

**Design only. No code written. Awaiting approval.**

Extends Module 14 (AI Public Offer Discovery). Phase numbering assumes this
lands as **Module 14 Phase 3+**, after the already-agreed Phase 2
(deterministic business-information extraction) — see "Sequencing" below for
why that order matters.

---

## 0. The two findings that shape everything else

### Finding 1 — most of the marketing copy needs no AI at all

Your three examples are the heart of this spec:

| Offer type | Requested copy |
|---|---|
| Buy One Get One | *"Looking for just one seat? … When another customer also joins, both of you unlock…"* |
| Buy 2 Get 3 | *"Show your interest even if your group isn't complete yet. Pairley helps build the required group…"* |
| Buy 5 Get 5 | *"Planning a large outing? … Once the required group size is achieved, everyone unlocks…"* |

Read them side by side and the pattern is exact: **each one is a pure
function of `offer_type` and `required_people`.** None of them says anything
about the specific merchant, the specific dish, or the specific price. They
explain *the Pairley mechanic*, and the mechanic is identical for every BOGO
offer on the platform.

That means this copy should be a **deterministic template catalog keyed on
offer type** — not LLM output. Three consequences, all good:

1. **Your "never promise a group will form" rule becomes structural.** It
   holds because no code path can emit a promise, not because a prompt asked
   a model politely and we hope it complied every time. That is the
   difference between a rule and a wish.
2. **It is free and instant.** No token cost, no latency, no rate limit, no
   provider outage on the path that renders a banner.
3. **It is reviewable once.** You approve the BOGO wording a single time and
   every BOGO offer on Pairley says exactly that, forever. Consistent
   branding is the stated goal, and templates are what consistency *is*.

This is the same pattern as Module 13's `LEAD_MESSAGE_TEMPLATES`: a
whitelisted catalog, server-enforced, extensible by adding one entry. It
already works well in this codebase.

**What genuinely does need an LLM** is the narrow part: rewriting the
merchant's own offer title and description into concise Pairley house style.
That's per-merchant, unpredictable input, and real judgement. Keep it
advisory and admin-reviewed, exactly as Module 11 established.

So the split is:

```
Offer card copy
├── Pairley mechanic explanation  → deterministic template (offer_type + required_people)
└── Merchant offer description    → LLM, advisory, admin-reviewed, never auto-published
```

### Finding 2 — merchant contact details are already public, today, for every offer

You asked for phone/email/WhatsApp to be hidden until signup. I checked
whether that's true now. It isn't:

`GET /offers/details/:id` uses `OptionalJwtAuthGuard` — **no login required**
— and returns, to an anonymous caller:

```
business.mobile        business.email         business.owner_name
business.address       business.city          business.state
```

This is not specific to AI-imported offers. **It is every offer on Pairley,
including every real merchant's, right now.**

The implication for this spec: hiding contact details *on the banner* would
be decoration. The banner is an image; the data sits one API call behind it,
readable by anyone with a browser console. **Contact protection is a backend
change to the public offer serializer**, and it's worth doing on its own
merits regardless of whether the rest of this engine is built.

I'd treat it as the first thing delivered, not the last — it's small, it's
independent, and it closes a real gap.

---

## 1. Concerns worth resolving before build

Raising these once, with mitigations. They're your call, and none of them
blocks the engine — they shape what it publishes.

### 1.1 "Pairley-exclusive" would be a false claim

The success criterion says every imported offer should appear as a
*"Pairley-exclusive marketplace listing."* But an imported offer is, by
definition, the merchant's own **publicly advertised** offer — running on
their website, available to anyone who walks in, from a business that hasn't
agreed to be on Pairley yet.

There is already an `is_pairley_exclusive` flag on `Offer`, described in the
schema as an admin-only badge. Setting it on AI-imported offers would state
something untrue to customers, and it's the kind of claim a competitor or a
consumer body can check in ten seconds.

**Mitigation:** keep the *design* premium — that's the real goal — without
the exclusivity claim. Badge these as **"Discovered on Pairley"** or
**"Verified public offer"**, and reserve `is_pairley_exclusive` for offers a
merchant actually gave you exclusively. You lose nothing visually and the
claim becomes defensible.

### 1.2 Reusing merchant photography and logos

The image-selection priority list is hero image → product image → interior →
**business logo**. Downloading a merchant's photography and logo and
compositing them into Pairley-branded marketing banners is a different act
from linking to their page. Public accessibility is not a licence to reuse.

**Mitigation, in order of preference:**
1. Prefer **category/stock imagery you own** for the banner background, with
   the merchant's own image shown as a clearly-attributed thumbnail.
2. If using their image, keep the **source URL visible** (already stored in
   `original_import_url`) and keep the existing **takedown path** one click
   away — the module already has both.
3. Never composite a merchant's **logo** into a Pairley-branded banner for a
   business that hasn't claimed their listing. A logo is a trademark, and
   using it implies endorsement.

### 1.3 AI rewriting terms of a real business's offer

If the model turns "Buy One Get One on weekdays before 6pm" into "Buy One Get
One", Pairley has published inaccurate commercial terms attributed to a named
business that never agreed to any of it. The customer turns up and is refused.

Your own "never promise a group will form" rule shows you already think this
way — this is the same risk one level up.

**Mitigation:** the LLM may **compress and restyle**, never **add or drop a
condition**. Concretely: extracted conditions (times, dates, minimum spend,
exclusions) are carried as structured fields and rendered from those fields,
not from prose the model wrote. Any offer where extraction found a condition
the model's output doesn't preserve gets flagged for the admin rather than
auto-passing.

### 1.4 Gating a merchant's own public phone number

Contact protection is right for *Pairley's* leads. But taking a phone number
a merchant publishes freely on their own site, and putting it behind a Pairley
signup while showing their offer, does affect that merchant — a customer who
would have called them directly now has to join Pairley first.

**Mitigation:** it's defensible for **claimed** merchants (they agreed to the
model) and for Pairley-originated leads. For an **unclaimed** business I'd
show a neutral *"Contact details on the merchant's own site"* with the source
link, rather than implying Pairley is the gatekeeper to a number the merchant
published themselves. This also makes the merchant-acquisition pitch honest:
*claim your listing to manage how customers reach you.*

None of these change the engine's architecture. They change ~4 strings and
one image-selection default.

---

## 2. Architecture

```
Website / PDF / Poster / Screenshot
        │
        ▼
  EXISTING PIPELINE — unchanged
  UrlFetch (robots) │ OCR │ PdfText │ ContentExtraction │ TextExtraction
        │
        ▼
  ┌──────────────────────────┐
  │ MultiOfferDetection      │  NEW — splits one source into N offer blocks
  │ (LLM, structured output) │
  └──────────┬───────────────┘
             │ per detected offer
             ▼
  NormalizationService ────────  EXISTING, per offer, unchanged
  DuplicateDetectionService ───  EXISTING, per offer, unchanged
  EnrichmentService ───────────  EXISTING interface, LLM provider added
             │
             ▼
  ┌──────────────────────────┐
  │ OfferCopyService         │  NEW
  │ ├ mechanic copy → TEMPLATE (deterministic, offer_type keyed)
  │ └ description   → LLM (advisory, admin-reviewed)
  └──────────┬───────────────┘
             ▼
  ┌──────────────────────────┐
  │ ImageSelectionService    │  NEW — deterministic ranking + sharp crop
  └──────────┬───────────────┘
             ▼
  ┌──────────────────────────┐
  │ BannerRenderService      │  NEW — sharp template composition (not generative)
  └──────────┬───────────────┘
             ▼
  Admin review — N offers, each independently approvable
             │
             ▼
  Publish (contact-protected serializer)
```

### 2.1 Banner generation: composed, not generated

**Recommendation: render banners as templates composed with `sharp`, not with
an image-generation model.** This is a firm recommendation, not a toss-up:

| | Template composition (`sharp`) | Generative model |
|---|---|---|
| Text accuracy | Exact — you supply the string | Unreliable; image models still garble text, and a banner is ~10 text fields (price, group size, discount %, business name…) |
| Brand consistency | Identical every time | Varies per generation |
| Cost | Free | Per image, per regeneration |
| Speed | ~100ms | Seconds |
| Regenerate after an admin edit | Instant | Another paid call |
| Wrong output | Impossible by construction | Needs human review every time |

A "banner" here is a **designed layout with data fields** — hero image,
logo, title, price, badge, CTA — not artwork. That is a templating problem.

`sharp` is already a dependency, and SVG-text-into-raster compositing is
already proven in this repo: I used exactly that technique this session to
generate the OCR test posters, and Tesseract read the result back at 95%
confidence. The capability is in place.

Generative imagery has one legitimate use here: producing a **category
background plate** (e.g. an abstract gym or dining texture) when no usable
merchant image exists. Those can be generated **once per category**, stored,
and reused — a dozen images total, not one per offer. That also sidesteps
§1.2 entirely.

### 2.2 Multi-offer detection

The one place a model genuinely earns its cost: deciding that a restaurant
page contains six distinct offers and splitting the text accordingly.

Constraints:
- **Structured output only** (JSON schema / function calling), never free
  prose to be parsed with regex.
- **Every detected offer must cite the source text span it came from.** Cheap
  to store, and it's what lets an admin check an offer is real rather than
  invented. This is the single most important safeguard in the whole design —
  a hallucinated seventh offer is the worst failure mode available.
- **A cap** (say 10 per source) so one pathological page can't create fifty
  candidates.
- **Zero detected offers is a valid result**, not an error — most pages have
  no offer, as the GitHub-homepage finding from Phase 1 verification showed.

### 2.3 Cardinality change

Today: one `ImportJob` → one `Business` + one `Offer`.
Needed: one `ImportJob` → one `Business` + **N** `Offer`s.

`ImportJob.created_offer_id` is singular. Rather than change its meaning
(and break the Phase 1 admin UI that reads it), add `created_offer_ids
String[]` and keep the existing field pointing at the first offer for
backward compatibility.

---

## 3. Database impact

Additive only. No destructive changes.

| Table | Column | Type | Why |
|---|---|---|---|
| `import_jobs` | `created_offer_ids` | `String[]` | Multi-offer results; existing singular field kept for compatibility |
| `offers` | `marketing_copy` | `String?` | The generated Pairley description |
| `offers` | `mechanic_copy_key` | `String?` | Which deterministic template was used — the copy itself is rendered, not stored, so wording fixes apply retroactively |
| `offers` | `source_excerpt` | `String?` | The source span this offer was detected from — the anti-hallucination audit trail |
| `offers` | `banner_status` | `String?` | `PENDING / GENERATED / FAILED` |
| `offers` | `terms_conditions` | `String?` | Already identified in the Phase 1 proposal; needed here for §1.3 |
| `offers` | `max_people` | `Int?` | Already identified in the Phase 1 proposal |

**Reused, not added:** `generated_offer_card` **already exists** on `Offer`,
schema-commented *"Pairley 2.0 — AI-generated card, unused until Group B."*
That is precisely this banner, reserved years ago. `original_poster` likewise.
Neither needs creating.

---

## 4. Contact protection

Independent of everything else, and worth shipping first.

1. Remove `mobile`, `email`, `owner_name` from the **anonymous** branch of
   `getDetails`, and audit `listOffers` / search / category endpoints for the
   same leak.
2. Return a `contact_available: boolean` instead, so the UI can render
   *"📞 Contact available after free signup"* without the value being present
   in the payload at all. **If the number is in the JSON, it is public** —
   masking in the frontend is not protection.
3. Authenticated customers get contact details per your access rules;
   unclaimed businesses get the §1.4 treatment.
4. Merchant-side lead masking (Module 13) is unchanged and already correct.

---

## 5. Admin experience

Extends the Phase 1 review screen rather than replacing it.

```
┌──────────────────────────────────────────────────────────────┐
│  IMPORT COMPLETE — specgym.in                                │
│  6 offers detected                    [ Approve selected (3) ]│
├──────────────────────────────────────────────────────────────┤
│ ☑ ┌────────────┐  BOGO Buffet              ● High           │
│   │  [banner]  │  ₹1,200 → ₹600 pp · 2 people                │
│   └────────────┘  "Looking for just one seat?…"              │
│                   [Preview] [Edit] [Image] [Regenerate] [✗]  │
├──────────────────────────────────────────────────────────────┤
│ ☑ ┌────────────┐  Weekend Family Combo     ◐ Medium         │
│   │  [banner]  │  ₹2,400 → ₹1,800 · 4 people                 │
│   └────────────┘  ⚠ Source text didn't state an end date     │
│                   [Preview] [Edit] [Image] [Regenerate] [✗]  │
└──────────────────────────────────────────────────────────────┘
```

Per offer: Preview · Edit content · Replace image · Regenerate copy ·
Regenerate banner · Save Draft · Approve · Reject — each **independent**, as
specified. Bulk approve exists already and extends naturally.

**Two-tab preview**, as requested:

| Original Source | Pairley Preview |
|---|---|
| Source page/file, original images, raw extracted text, **and the highlighted span this offer came from** | Final banner, marketing copy, selected image, offer summary, contact placeholders, CTA, badges |

The highlighted-span link between the two tabs is what makes the review
meaningful rather than cosmetic — it answers "is this offer actually on that
page?" in one glance.

---

## 6. Sequencing

**This should land after the already-agreed Phase 2, not instead of it.**
Phase 2 is deterministic extraction of business name, phone, website, email,
address, GST. This engine needs every one of those: a banner shows the
business name and location, and contact protection is meaningless if there's
no contact to protect. Building the engine first means generating banners
that say *"example.com (imported)"* — which is what candidates are called
today.

| Phase | Scope | Cost | Risk |
|---|---|---|---|
| **2** (agreed) | Deterministic business-info extraction | Free | Low |
| **3a** | **Contact protection** — backend serializer fix | Free | Low, ship independently |
| **3b** | Mechanic copy templates + banner rendering (`sharp`), fed by *existing* single-offer extraction | Free | Low — no LLM at all |
| **3c** | LLM description rewriting, advisory | Metered | Medium |
| **3d** | Multi-offer detection | Metered | Highest — hallucination risk |

**Recommendation: 3a and 3b are worth doing on their own.** Together they
deliver most of the visible "premium marketplace" outcome — branded banners,
consistent Pairley copy, protected contacts — with **no AI cost and no
hallucination risk whatsoever**, because at that point nothing is generated,
only composed. Multi-offer detection is the genuinely expensive, genuinely
risky part, and it's separable.

---

## 7. Open questions

1. **Exclusivity badging** — confirm "Discovered on Pairley" over
   "Pairley-exclusive" (§1.1)?
2. **Merchant imagery** — own/stock backgrounds by default, or merchant
   photography with attribution and takedown (§1.2)?
3. **Merchant logos** — I recommend never compositing a logo for an unclaimed
   business (§1.2). Confirm?
4. **Unclaimed-merchant contact** — gate behind signup, or link to the
   merchant's own site (§1.4)?
5. **LLM provider and budget ceiling** — OpenAI was the stated preference at
   Module 11. Per-import cap and monthly ceiling need setting *before* 3c.
6. **Scope to approve now** — 3a+3b only (free, low-risk, most of the visual
   payoff), or the full 3a–3d?

Questions 1–4 change what gets published and I'd want them settled before
3b. Questions 5–6 can wait until 3c.
