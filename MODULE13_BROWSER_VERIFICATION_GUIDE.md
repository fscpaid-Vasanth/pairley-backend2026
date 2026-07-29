# Module 13 — Browser Verification Guide

This is the manual, browser-based verification requested before Module 13 goes
live for real merchants. It mirrors your checklist exactly (Customer, Merchant,
Persistence, Security) with concrete steps, expected results, and a results
table to fill in and send back.

I can't run a browser myself — no automation tooling is available in this
environment — so this needs to be run by hand, the same way Firebase Storage
live verification was.

## Setup — before you start

You need **two customer accounts** and **two merchant accounts**, and at
least one **non-legacy** ACTIVE offer under each merchant (STANDARD,
PERCENTAGE_DISCOUNT, FLAT_DISCOUNT, FLASH_DEAL, etc. — anything *except*
BOGO/BOGT/GROUP_DISCOUNT/BULK_PURCHASE/MEMBERSHIP_CAMPAIGN/PACKAGE_DEAL, which
still use the old pool-chat mechanic and aren't part of this module).

- **Merchant A / Merchant B** — reuse two of your already-approved test
  businesses (e.g. from the admin dashboard's Shop Onboardings list) so you
  don't need to wait through the approval cycle. Confirm each has at least
  one ACTIVE non-legacy offer; create one via **Create Your Offer** if not.
- **Customer A / Customer B** — reuse two existing customer accounts if you
  have them, or register two new ones via the normal signup flow (customer
  OTP is unaffected by Module 13 or the merchant OTP pilot — real SMS still
  applies unless `USE_MOCK_OTP=true` is set).
- Keep note of each account's login and, for merchants, the Lead ID each
  test produces (visible in the URL when you open **Chat with Your Offer
  Partner**, or in the admin dashboard) — the Security section needs a
  lead/chat ID that belongs to the *other* merchant/customer.

**Note on the chat itself**: this is a guided workflow, not a chat window.
There is no typing anywhere. All four sections render stacked and always
visible — no tabs to switch: **Quick Actions** (tap-to-send prompts),
**Schedule Meeting** (a standing date+time picker), **Share Location**
(fixed spots + "Share Live Location," which prompts for browser geolocation
permission), **Offer Status** (deal-progress prompts).

---

## Customer flow

| # | Step | How | Expected result |
|---|---|---|---|
| 1 | Login | Log in as **Customer A** | Lands on customer dashboard |
| 2 | View Offer | Open a non-legacy ACTIVE offer from **Merchant A** | Offer detail page loads; button reads **"Show Interest"** (not "Show Interest & Get Split Pricing" — that copy is legacy-only) |
| 3 | Show Interest | Click **Show Interest** | Button shows "Sending Interest..." briefly, then the page swaps to the confirmation card: **"✅ Interest Sent Successfully — Merchant has been notified... [ Chat with Your Offer Partner ]"** — no WhatsApp tab/popup opens anywhere |
| 4 | Refresh page | Hard refresh (Ctrl/Cmd+Shift+R) | Same confirmation card reappears, headline now **"Interest Already Sent"** (not "Show Interest" again) |
| 5 | Verify duplicate prevention | Open browser DevTools → Network, or just try clicking "Show Interest" again if it were visible | The button is gone/replaced by the card, so a duplicate click isn't even possible from the UI. Optional: confirm via a second tab open to the same offer at the same time — the second attempt should show "already shown interest," not a second lead |
| 6 | Open Chat | Click **Chat with Your Offer Partner** | Navigates to `/customer/lead-chat/:leadId`; page header reads **"Chat with Your Offer Partner,"** empty thread, four stacked sections below it (Quick Actions / Schedule Meeting / Share Location / Offer Status) — **no tabs, no text input anywhere** |
| 7 | Send structured messages | Tap **Quick Actions → "📅 When shall we meet?"**; then in the always-visible **Schedule Meeting** widget, pick a date and time, tap **Send** | First message appears immediately as a bubble on the right, labeled "You," reading exactly "📅 When shall we meet?". Second appears as "📅 I will be available on [date] at [time]" — both persist on refresh |
| 8 | Confirm no free text is reachable | Try to find a keyboard-entry field anywhere on this page, including via browser DevTools | None exists (the date/time inputs are structured pickers, not free text) — every message is a tap on a predefined option |

## Merchant flow

| # | Step | How | Expected result |
|---|---|---|---|
| 1 | Receive notification | As **Merchant A**, check the bell icon after Customer A's step 3 above | "New Lead!" notification appears within ~5s (polled); clicking it deep-links straight to **Leads** (not home) |
| 2 | View lead | Go to **Business → Leads** | New row appears: name shown as *"Anonymous Customer"* with a 🔒 icon, offer name, "Interested on [today's date]" |
| 3 | Verify customer details are masked | Look at the mobile column | Shows **"•••••••••• (locked)"**, not a real number |
| 4 | Reply through the chat | Click **Chat** on that row | Navigates to `/business/lead-chat/:leadId`, header reads "Chat with Your Offer Partner"; you see Customer A's two messages from steps 7–8 above, labeled "Customer." Reply via **Quick Actions → "👍 Thank you."** — it should appear labeled "You" on your side and "Merchant" on Customer A's side when they refresh. Optionally also try **Offer Status → "✅ Offer redeemed successfully."** to confirm the new section works from the merchant side too |
| 5 | Unlock customer details | Click **Unlock Customer Details** | Button disappears, replaced by **Contact**; toast confirms; row now shows the real name |
| 6 | Verify contact information becomes visible | Look at the row again | Real name and real mobile number now shown, no lock icon |
| 7 | Use the Contact action | Click **Contact** | Opens WhatsApp with a prefilled message to the now-visible number — this is the merchant's own explicit outreach, separate from anything automatic |

## Persistence

Re-check Customer A's confirmation-card state (step 4 above) and Merchant A's unlocked lead (step 6 above) across:

| # | Condition | How | Expected result |
|---|---|---|---|
| 1 | Browser refresh | Hard refresh both pages | Both states survive exactly as left |
| 2 | Logout/Login | Log out, log back in as the same account | Same states survive |
| 3 | Different browsers | Open the same account in a second browser (or incognito) | Same states appear immediately — this is the core proof it's backend-driven, not local storage |
| 4 | Mobile App | If you have the Capacitor build available, repeat the customer flow there | Same states (API is identical regardless of client) — mark N/A if the mobile build isn't readily testable right now |
| 5 | Web App | Already covered by steps 1–3 above | — |

## Security

| # | Check | How | Expected result |
|---|---|---|---|
| 1 | Customer A cannot access Customer B's chat | Log in as **Customer B**, manually navigate to Customer A's lead-chat URL (`/customer/lead-chat/:leadId` from step 6 above) | 403 error, no messages shown |
| 2 | Merchant A cannot access Merchant B's leads | Log in as **Merchant B**, try `/business/lead-chat/:leadId` using Merchant A's lead ID, and check `GET /leads` never lists Merchant A's rows | 403 on the chat route; Merchant A's leads never appear in Merchant B's list |
| 3 | Locked customer details remain hidden until unlock | Create a *fresh* second interest (Customer B → Merchant A, different offer or new account) and check Merchant A's Leads page before clicking Unlock | Still shows "Anonymous Customer" / locked mobile — confirms masking isn't accidentally bypassed by having unlocked a different lead earlier |
| 4 | Anonymous chat remains anonymous before unlock | In the still-locked chat from check 3, exchange a message both directions | Labels stay "You"/"Customer"/"Merchant" throughout — never a real name, even mid-conversation, even after other leads have been unlocked |

---

## Reporting back

For each numbered item above, note **Pass / Fail** and, for any fail, what
you saw instead (screenshot if easy, exact error text if not). Once you send
this back, I'll prepare the Final Verification Report, the updated flow
diagrams, API documentation, database change log, and release notes exactly
as requested — held until your results are in, per the sequencing you asked
for.
