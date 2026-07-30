# Module 15 — Merchant Offer Validation

**Status: scoped, not started.** Opened from a Module 14 Phase 3C finding.
Deliberately sequenced *after* Phase 3C: the banner engine is behaving
correctly, so this is not a blocker for that milestone.

---

## 1. Why this exists

Building Template F required reading `original_price` and `offer_price`
literally, which exposed that merchants do not all mean the same thing by
them. The platform assumes both are **per person** — the customer-facing
`DealCard` renders `offer_price` as the price, `original_price` struck
through, and the difference as "Save ₹X". Some merchants are entering
**group totals** instead.

The banner engine is not at fault and needs no further change. The input is
inconsistent, and every downstream feature inherits that: discount
percentage, savings figures, the Template F savings box, search/price
filters, and analytics.

## 2. Evidence — audit of production offers, 2026-07-30

15 offers total: 1 ACTIVE, 2 DRAFT, 4 REJECTED, 8 EXPIRED.

**Three distinct failure modes, all confirmed against live rows.**

### A. Group total entered as `original_price` — 2 offers

Detected where `original_price ÷ required_people` lands almost exactly on
`offer_price` with more than 2 participants.

| Status | Stored | Implied discount | Title |
|---|---|---|---|
| EXPIRED | orig 10,000 / off 2,000 / n 5 | **80% off** | "AI Tool Course Available" |
| REJECTED | orig 30,000 / off 6,000 / n 5 | **80% off** | "Spec Gym 6 Months Monsoon Offer" |

In both, ₹10,000 ÷ 5 = ₹2,000 and ₹30,000 ÷ 5 = ₹6,000 — the merchant
almost certainly meant "₹30,000 for the group, ₹6,000 each". The platform
reads it as an 80%-off per-person discount and would advertise it as such.

### B. Participant count contradicting the offer's own terms — 1 offer

**This is the only ACTIVE offer on the platform.**

```
"6 Month Monsoon Offer - Per Head 3000 for 5 Members Minimum"
original_price 5,000 | offer_price 3,000 | required_people 1 | STANDARD
```

The prices are entered correctly per-head and match the title. The
*participant count* is wrong: the title requires 5 members, the record says
1. Consequences today:

- Template F is withheld entirely (it requires ≥ 2 participants), so a
  genuine group offer cannot use the group banner.
- The show-interest / unlock mechanic doesn't engage — it behaves as a solo
  offer.
- It is typed `STANDARD` rather than a group type.

Pricing validation alone would not have caught this. Participant count needs
validating in its own right.

### C. Zero-priced import scaffolding reaching a saveable state — 3 offers

Two `"Example Domain"` rows and one HTML-entity-mangled title
(`"The Big Barbeque &#8211; …"`) sit at REJECTED/DRAFT with
`original_price = 0, offer_price = 0`. Discovery artifacts that should never
have become offer records.

### The blind spot that motivates explicit pricing mode

For a 2-person offer at exactly 50% off, `original ÷ people = offer` is an
**arithmetic identity** — it is equally true whether the merchant entered
per-person or group-total figures. No after-the-fact heuristic can tell
those apart, and every BOGO on the platform sits in exactly that case.

This is the strongest argument for capturing pricing mode **at entry**
rather than inferring it later: for a large class of offers the information
is simply not recoverable afterwards. (It is also the same coincidence that
concealed two Template F defects until they were rendered against
production data — see `MODULE14_TEMPLATE_F_COST_SPLIT.md` §5.)

## 3. Scope

### 3.1 Explicit pricing mode

A required choice on offer entry, stored rather than inferred:

- **Per Person** — the price each participant pays (current platform assumption)
- **Total Group Price** — the price for the whole group, divided by participant count for display

Defaulting to Per Person preserves today's behaviour for existing records.
The stored mode makes the merchant's intent explicit and permanently
recoverable.

### 3.2 Live discount preview

Show the computed discount as prices are typed, in the customer's words:
*"Customers will see: ₹6,000, was ₹30,000 — Save ₹24,000 (80% off)"*. The
two Mode-A offers above would have been caught by the merchant at entry.

### 3.3 Live banner preview

Render the Module 14 banner alongside the form as prices change. A merchant
who sees "80% OFF" on their own banner will correct it themselves. This
reuses the Phase 3C render path directly — no new rendering work.

### 3.4 Validation warnings for unrealistic discounts

Warn (do not hard-block) above a configurable threshold; ≥ 70% flagged both
Mode-A offers with no false positives in the current data. Pair with a
minimum-price sanity check. Warnings, not errors — a genuine clearance
offer must remain possible.

### 3.5 Participant/pricing consistency checks

- Participant count vs offer type: a group type with `required_people = 1`,
  or a group-sounding title with `required_people = 1`, is contradictory.
- Parse the merchant's own title for stated terms ("per head", "for N
  members") and flag disagreement with the structured fields. The one ACTIVE
  offer would have been caught by exactly this.
- Reject zero-priced offers from leaving DRAFT.

### 3.6 Backfill for existing records

The 15 current offers need review, not silent migration — for the 2-person
50% cases the original intent is unrecoverable, so it must be **asked**, not
guessed. Suggested: an admin review queue showing each offer as the customer
would see it, with a one-click pricing-mode correction.

## 4. Explicitly out of scope

- Changing how `DealCard` or the banner engine interpret stored prices. The
  per-person convention stays; this module makes input match it.
- Retroactively rewriting merchant data without review.

## 5. Suggested sequencing

1. Explicit pricing mode + live discount preview (prevents new bad data)
2. Consistency checks and unrealistic-discount warnings
3. Live banner preview in the offer form
4. Admin backfill queue for the existing 15 records

Step 1 alone stops the problem from growing, and is worth shipping before
merchant onboarding expands.
