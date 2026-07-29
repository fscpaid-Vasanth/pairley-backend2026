# Module 13 — Deal Coordination Assistant

Replaces the old "Show Interest → WhatsApp redirect" flow with an in-app,
structured coordination experience. Pairley is the primary engagement
platform; WhatsApp is an optional, lowest-priority, merchant-configurable
notification channel, not a step in the customer journey.

Scope: applies to non-legacy offer types (STANDARD, PERCENTAGE_DISCOUNT,
FLASH_DEAL, etc.) — anything except BOGO/BOGT/GROUP_DISCOUNT/
BULK_PURCHASE/MEMBERSHIP_CAMPAIGN/PACKAGE_DEAL, which keep their existing
`OfferInterest`-based pool-chat/capacity-matching mechanic untouched. That's
a different feature (coordinating multiple buyers to fill a group deal),
not what this module changes.

## Customer flow

```
Show Interest
  → POST /offers/lead (hard-blocks a repeat interest — Lead is unique per
     customer+offer)
  → Lead created
  → in-app Notification → merchant (primary channel; WhatsApp Business API
     alert also fires, opt-in via business.notify_whatsapp, lowest priority)
  ← confirmation card: "Interest Sent Successfully"
  ← [ Chat with Your Offer Partner ]

Refresh / logout+login / another device
  → GET /offers/details/:id returns myLead {id, status, unlocked}
  ← same confirmation card, "Interest Already Sent" — state is backend-
     driven, not local component state
```

## Merchant flow

```
🔔 "New Lead!" notification → deep-links to Leads
Leads page row: "Anonymous Customer" 🔒, offer, "Interested on <date>"
  [ Chat ]  [ Unlock Customer Details ]
       │              │
       ▼              ▼
  1:1 thread    POST /leads/:id/unlock (free, manual, one-way)
                 → real name/mobile now visible
                 → [ Chat ]  [ Contact via WhatsApp ]
```

## Chat with Your Offer Partner — a Deal Coordination Assistant, not a chat app

No free text, no keyboard, no arbitrary Send. Every message is a pick from
a server-enforced catalog — enforced at `POST /leads/:id/messages`, not
just hidden in the UI. Four sections, stacked and always visible (no tabs):

| Section | Items (in order) | Behavior |
|---|---|---|
| ⚡ Quick Actions | 📅 When shall we meet? · 🏪 Shall we meet at the shop counter? · 🚗 I have reached the shop. · ⏳ I am running late. · 👍 Thank you. · 😊 Looking forward to meeting. | Tap → sends immediately |
| 📆 Schedule Meeting | Date picker + Time picker | Tap Send → "📅 I will be available on 29 Jul 2026 at 5:30 PM" |
| 📍 Share Location | 📍 Shop Counter · 📍 Shop Entrance · 📍 Parking Area · 📍 Share Live Location | Fixed three send immediately; Live requests browser geolocation |
| 📦 Offer Status | ✅ I have collected the offer. · ✅ Offer redeemed successfully. · ❌ Unable to visit today. · 🔄 Can we reschedule? | Tap → sends immediately |

Identity stays anonymous on both sides regardless of unlock state —
unlocking reveals contact info on the Leads list, never inside the thread.

## API

- `GET /leads/message-templates` — the catalog above, grouped by category
  in the fixed order, both roles. No functions/analytics data leak to the
  client; just `{key, label, messageType, requiresPayload}` per item.
- `POST /leads/:id/messages` — body `{templateKey, payload?}`. `payload`
  required only for `SCHEDULE_AVAILABLE_ON` (`{date, time}`, validated
  including real calendar-date checking) and `LOCATION_LIVE` (`{lat, lng}`).
  Unknown `templateKey` or invalid payload → 400. Ownership enforced:
  exactly the lead's own customer or business, nobody else.
- `GET /leads/:id/messages` — unchanged shape; `text` is always the final
  rendered string regardless of type, so the feed never needs type-specific
  rendering logic.
- `POST /leads/:id/unlock` — business-only, free, manual, idempotent.
- `GET /offers/details/:id` — includes `myLead` for the requesting
  customer.

## Database

- `leads.unlocked_at` (nullable) + `@@unique(customer_id, offer_id)` —
  real hard duplicate-interest block, replacing the old 24h soft window.
- `lead_messages` — `message_type` (`STATEMENT | SCHEDULE | LOCATION`),
  `text` (always pre-rendered display string), `payload` (nullable JSON,
  structured data for SCHEDULE/LOCATION_LIVE).
- `lead_interaction_events` (new) — durable analytics log, one row per
  event a sent template maps to (a schedule send logs both `DATE_SHARED`
  and `TIME_SHARED`). Not read by anything today; this is the data the
  future analytics work will query. Logged fire-and-forget — a logging
  failure never blocks or fails the actual message send.

Event types currently logged: `MEETING_REQUESTED`, `MEETING_CONFIRMED`,
`RUNNING_LATE`, `ACKNOWLEDGED`, `DATE_SHARED`, `TIME_SHARED`,
`LOCATION_SHARED`, `OFFER_COLLECTED`, `OFFER_REDEEMED`, `VISIT_CANCELLED`,
`RESCHEDULED`.

## Extensibility

Adding a new fixed-text template (e.g. `PAYMENT_CONFIRMATION`) is one entry
in `LEAD_MESSAGE_TEMPLATES` (`leadMessageTemplates.ts`) with its
`analyticsEvents` — no schema change, no controller change, no frontend
change; it appears in its category automatically via
`GET /leads/message-templates`. A template needing a genuinely new kind of
structured input (beyond date+time or lat/lng) is the one case that would
need new frontend UI, same as `SCHEDULE`/`LOCATION_LIVE` did.

## Files

**Backend**: `leadMessageTemplates.ts` (catalog + renderer, pure/testable),
`lead.service.ts`, `lead.controller.ts`, `offer.service.ts`,
`offer.controller.ts`, `prisma/schema.prisma` + 3 migrations.

**Frontend**: `LeadChatThread.jsx`/`.css` (the assistant UI),
`CustomerLeadChatPage.jsx`, `BusinessLeadChatPage.jsx`, `InterestButton.jsx`,
`LeadsPage.jsx`, `leadMessageTemplates.js` (click-dispatch logic).

## Test coverage

Backend: 55 lead-module tests (catalog rendering incl. real calendar-date
validation, whitelist enforcement, unlock ownership/idempotency, chat
access control both directions, analytics event logging including a
logging-failure-doesn't-block-send case). Full suite 401/402 (1 pre-existing,
unrelated failure). Frontend: 44/44, including the click-dispatch pure
functions (`getItemInteraction`, `buildSchedulePayload`).

## Status

Implementation approved and committed. **Live browser end-to-end
verification is still pending** — see
`MODULE13_BROWSER_VERIFICATION_GUIDE.md` for the checklist. Nothing here
has been confirmed working in a real browser against real accounts yet.
