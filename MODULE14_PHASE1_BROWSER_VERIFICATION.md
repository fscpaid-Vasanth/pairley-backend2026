# Module 14 Phase 1 — Verification

Part 1 records what has **already been verified** by driving the real
services against the real network and real files. Part 2 is the manual
browser checklist for what's left — I can't drive a browser in this
environment, so that part needs running by hand.

---

# Part 1 — Already verified (service layer)

Run against the compiled services with **real network I/O and real files**.
No database writes, no production side effects, nothing mocked except the
duplicate-detection candidate pool.

## Website URL import

| Case | Target | Result |
|---|---|---|
| Valid website | `example.com` | ✅ fetched 282ms · title "Example Domain" · confidence 0.4 |
| Valid website | `google.com` | ✅ fetched 467ms · title "Google" · confidence 0.4 |
| Invalid website (malformed) | `not a url` | ✅ `INVALID_URL`, 0ms, no network call |
| Invalid website (scheme) | `ftp://example.com/x` | ✅ `INVALID_SCHEME`, 0ms |
| Invalid website (SSRF) | `127.0.0.1` | ✅ `SSRF_BLOCKED`, 0ms |
| Invalid website (SSRF) | `169.254.169.254` (cloud metadata) | ✅ `SSRF_BLOCKED`, 0ms |
| **robots.txt blocked** | `instagram.com/p/ABC123/` | ✅ `ROBOTS_DISALLOWED` — "disallows /p/ABC123/ for PairleyOfferImportBot" |
| **robots.txt blocked** | `facebook.com/somepage` | ✅ `ROBOTS_DISALLOWED` |
| robots.txt allowed | `github.com/anthropics` | ✅ permitted — the check permits as well as blocks |
| robots.txt specificity | `github.com/search?q=test` | ✅ blocked by GitHub's own `Disallow: /search` |
| **Redirect handling** | `http://github.com/` → `https://github.com/` | ✅ followed, 990ms, final URL recorded, robots re-checked on the hop |
| HTTP error | `example.com/definitely-not-here` | ✅ `HTTP_ERROR` (404), 42ms |
| Unsupported content type | `google.com/favicon.ico` | ✅ `UNSUPPORTED_CONTENT_TYPE` (image/x-icon), 40ms |
| **Timeout handling** | `example.com:81` (filtered port) | ✅ `TIMEOUT` at 15.0s |

## Image upload

Real `sharp`-generated poster, real `tesseract.js` OCR.

| Case | Result |
|---|---|
| **Poster** (PNG, offer text) | ✅ OCR read *"SPEC GYM 6 Months Monsoon Offer Rs 30000 for 5 people Call 9876543210"* · title "SPEC GYM" · **price 30000 parsed correctly** · OCR confidence 0.95 · overall 0.92 · 314ms |
| **Screenshot** (JPEG, same content) | ✅ identical extraction, 276ms — same pipeline as poster, as designed |
| **Large image** (25.8MB PNG) | ✅ `FILE_TOO_LARGE` rejected at 0ms, before any processing |
| **Invalid image** (text file named `.png`) | ✅ `INVALID_FILE_SIGNATURE` — magic-byte check caught it, extension ignored |

## PDF upload

Against genuine PDFs (`pdf-parse` test corpus), not hand-built fixtures.

| Case | Result |
|---|---|
| **Single-page PDF** | ✅ `05-versions-space.pdf` — 22 chars extracted, 10ms |
| **Multi-page PDF** | ✅ `01-valid.pdf` — 82,756 chars across a 14-page paper, 185ms · also `02-valid` (24,174 chars) and `04-valid` (20,211 chars) |
| **Invalid PDF** | ✅ `03-invalid.pdf` — `PDF_PARSE_FAILED`, 2ms, no crash |

## Duplicate detection

Candidate: *"Spec Gym 6 Months Monsoon Offer"*, ₹30,000 → ₹6,000, fitness.

| Case | Result |
|---|---|
| **No duplicate** (unrelated salon offer) | ✅ no match — below the 0.55 threshold |
| **Exact duplicate** (identical offer, same merchant) | ✅ **score 1.00** — "Title is an exact or near-exact match \| Price matches (within 10%) \| Same category \| Likely the same merchant" |
| **Partial duplicate** ("3 Months" variant, different price, "Spec Gym Anna Nagar") | ✅ **score 0.67** — "Title is closely similar (71% word overlap) \| Same category \| Likely the same merchant" |

Nothing was auto-merged in any case — flags only, as designed.

## Security — access control

Backend booted on :3111 against the **real production database**. JWTs minted
for each role. Every discovery route, every role:

| Route | Admin | Merchant | Customer | No token |
|---|---|---|---|---|
| `GET /discovery/jobs` | ✅ 200 | ✅ **403** | ✅ **403** | ✅ 401 |
| `GET /discovery/candidates` | ✅ 200 | ✅ **403** | ✅ **403** | ✅ 401 |
| `POST /discovery/import` | ✅ 400¹ | ✅ **403** | ✅ **403** | ✅ 401 |
| `PUT /discovery/candidates/:id/draft` | ✅ 404² | ✅ **403** | ✅ **403** | ✅ 401 |
| `PUT /discovery/candidates/:id/approve` | ✅ 404² | ✅ **403** | ✅ **403** | ✅ 401 |

¹ Validation rejection of a deliberately invalid URL — proves the request
reached the handler. ² Candidate-not-found for a non-existent UUID — proves
the route exists and the guard passed. Both confirm admin access works;
neither is a failure.

Merchants and customers are refused at the guard on **every** route,
including the two new/changed ones.

## Review lifecycle — Edit / Save Draft / Reject

Run end to end over real HTTP against the real database.

| Step | Result |
|---|---|
| Import `example.com` | ✅ job DONE, candidate created |
| `GET /candidates/:id` | ✅ returns the new `import_job` block (raw extracted title matched) plus `subtitle`, `required_people`, `start_date`, `end_date` |
| **Edit** — offer price above original | ✅ **400** "Offer price cannot be higher than the original price." |
| **Edit** — end date before start | ✅ **400** "End date must be after the start date." |
| **Save Draft** — 9 fields across offer *and* business | ✅ 200 |
| Re-fetch | ✅ all persisted: title, ₹30,000→₹6,000, 5 people, category `fitness`, business name, mobile, city |
| Still in the queue? | ✅ **`review_status = REVIEW_REQUIRED`** — saved, **not published** |
| Audit trail | ✅ `AI_IMPORT → REVIEW_DRAFT_SAVED` |
| **Reject** | ✅ 200, `review_status = REJECTED` |
| Final audit trail | ✅ `AI_IMPORT → REVIEW_DRAFT_SAVED → REVIEW_REJECTED` |

**Approve was deliberately not exercised here.** Approving sets the offer
`ACTIVE`, which would publish a junk test offer live to customers on
production. It is covered by unit tests instead, and `approve()` and
`saveDraft()` share one `applyOverrides()` code path — the only difference
between them is the status transition, which is itself unit-tested. Approve
still needs the browser check (**F9**).

### Test data created

One candidate, left in a terminal, non-public state:

- Offer `1db56688-3693-40fa-93d6-96365ab6d972` — `REJECTED` (never visible to
  customers).
- Its business — renamed to **"VERIFICATION TEST - Module 14 Phase 1
  (ignore)"**, `UNCLAIMED`.
- **The fake mobile `9000000001` was released back to null.** `Business.mobile`
  is a unique column, so leaving it would have blocked a real merchant who
  later tried to register with that number.

Nothing was hard-deleted, consistent with the Module 12 principle that this
system soft-removes rather than destroys.

## Notes from these runs

1. **A filtered host costs ~15s, not 10s.** The robots.txt lookup times out
   first (5s) and then the page fetch times out (10s). Correct behavior, but
   worth knowing: robots adds up to 5s of latency on unreachable hosts.
2. **The price extractor produced `price=0` with `confidence=1.00` on the
   GitHub homepage** — a page with no offer on it at all. This is
   pre-existing Module 9 extraction behavior, not something this phase
   changed, but it means a high confidence score does not currently mean
   "this is really an offer." Worth addressing in Phase 2 alongside the
   extraction work.
3. **OCR read the phone number** (`9876543210`) straight out of the poster
   text, but nothing maps it to `Business.mobile` — empirical confirmation
   that the Phase 2 contact-extraction work is a mapping problem, not a
   reading problem. The data is already there.
4. Wikipedia is unreachable from this environment (its `robots.txt` fetch
   fails at the network level), so that specific site was not exercised.

---

# Part 2 — Browser checklist

Same format as `MODULE13_BROWSER_VERIFICATION_GUIDE.md`. The cases below are
the ones that genuinely need a browser: UI state, button enablement, live
feed rendering, polling, and access control through the real app.

> **Sign-off, 2026-07-29.** The product owner marked the browser items
> complete and approved Phase 1 for commit. These checks were **not** run by
> the implementer — Part 1 above is the machine-verified record, and the
> rendering, polling, button-state, responsive-UI, and Approve-workflow items
> below rest on that sign-off rather than on a captured test run. Recorded
> plainly so a future reader doesn't mistake one kind of evidence for the
> other.

**Log in as an admin.** Everything here is admin-only; there is no merchant
or customer surface in this phase.

## Setup

- An admin account.
- A **real public offer page** — a local gym, restaurant, or salon with
  visible pricing. Avoid single-page-app sites that render entirely in
  JavaScript; extraction reads server-rendered HTML.
- A **poster image** (JPEG/PNG/WebP) with an offer on it.
- A **text-based PDF** (a menu or brochure exported from a document, not a
  scan).
- A **screenshot** of any public offer post.
- Optional but valuable: a URL you know is robots-disallowed. `https://www.instagram.com/p/<any-post>/`
  and `https://www.facebook.com/<any-page>` both work — verified as blocked
  by their own live robots.txt.

---

## A. Discovery screen

| # | Step | Expected |
|---|---|---|
| A1 | Open Admin Dashboard | A `🤖 AI Offer Discovery` tab appears between Deals Moderation and Discovered Offers |
| A2 | Click it | Four source buttons: Website, Poster, PDF, Screenshot. Website selected by default |
| A3 | Switch between sources | Exactly one input shows at a time; the hint text changes per source |
| A4 | Check the compliance note | Website source shows "Public pages only. We honour robots.txt and never access content behind a login." |
| A5 | Open with no imports ever run | Empty state reads "No imports yet", not a blank panel or a spinner |

## B. Website import

| # | Step | Expected |
|---|---|---|
| B1 | Paste a real public offer URL, click **Analyze using AI** | Button shows "Analyzing..." and stays disabled; completes within ~10s |
| B2 | On success | Toast "Offer extracted — review it in Discovered Offers." The URL field clears |
| B3 | Check Recent Imports | A row appears with the hostname, a timestamp, ✅ Done, and a **Review →** button |
| B4 | Type a bare domain (`specgym.in`, no `https://`) | Accepted — https is assumed |
| B5 | Type gibberish (`not a url`) | Inline red error under the field. **No import job is created** |
| B6 | Type `localhost` or `http://localhost:3000` | Rejected inline: "Enter a full public web address" |
| B7 | Press Enter in the URL field | Submits, same as clicking the button |
| B8 | Import a page with no readable offer (e.g. a plain homepage) | Inline message: "Nothing readable was found on that page…" — **not** a false success |

## C. robots.txt compliance ← the new control

| # | Step | Expected |
|---|---|---|
| C1 | Paste `https://www.instagram.com/p/<any-post-id>/` and Analyze | **Refused.** Inline: "This site's robots.txt asks us not to crawl that page, so we haven't. Upload a poster, PDF, or screenshot of the offer instead." |
| C2 | Same with `https://www.facebook.com/<any-page>` | Same refusal |
| C3 | Check Recent Imports after C1 | A ❌ Failed row with that same explanation — the refusal is recorded, not silently dropped |
| C4 | Confirm no content was fetched | The failed job created **no** draft offer; Discovered Offers gains nothing |
| C5 | Import a normal site that allows crawling | Still works — the check permits, it doesn't block everything |

## D. Poster / PDF / Screenshot import

| # | Step | Expected |
|---|---|---|
| D1 | Poster source → Choose Poster → pick a JPEG/PNG | Toast "Uploaded — extracting the offer in the background." Row appears as ⏳ Processing |
| D2 | Wait | Row flips to ✅ Done on its own without a manual refresh (polling), with a **Review →** button |
| D3 | Confirm polling stops | Once every row is Done/Failed, the network tab shows no further `/discovery/jobs` calls |
| D4 | PDF source | Only PDFs selectable in the file picker |
| D5 | Upload a **scanned/image-only** PDF | ❌ Failed with "This PDF appears to be scanned/image-only — text-layer PDFs only." |
| D6 | Upload a file over 15MB | ❌ Failed with "File is too large (15MB limit)." |
| D7 | Screenshot source → upload a screenshot | Behaves exactly like Poster (same pipeline) — this is the sanctioned route for social content |
| D8 | Click **Review →** on any Done row | Switches to the Discovered Offers tab |

## D2. Live feed

| # | Step | Expected |
|---|---|---|
| D2a | **Running** — start an upload and watch | Row appears as ⏳ Processing with a spinning icon |
| D2b | **Completed** | Flips to ✅ Done on its own, no manual refresh, and gains a **Review →** button |
| D2c | **Failed** | Flips to ❌ Failed with an admin-readable explanation, not a raw error code |
| D2d | **Polling stops** | Open DevTools → Network, filter `/discovery/jobs`. While a job is Processing, a request every ~3s. Once every row is Done/Failed, **the requests stop entirely** |
| D2e | Reload with only terminal jobs | Exactly one `/discovery/jobs` request on load, then none |

## E. Admin review — the four panels

Open a candidate from Discovered Offers.

| # | Step | Expected |
|---|---|---|
| E1 | Left panel | **Original Source** — poster inline, PDF as an open link, or a link to the source page |
| E2 | Below it | **AI Extracted Content** — title, description, price, and (for OCR) confidence. Missing values show a grey italic "not detected", not a blank |
| E3 | Expand "View raw extracted text" | The full text the pipeline read, scrollable |
| E4 | Right panel | **Pairley Offer** — every field in an editable input |
| E5 | Top-right badge | Confidence as a percentage **and** a High / Medium / Low label |
| E6 | Business section | Name, category, type, phone, website, address, city, state, pincode, GST — all editable |
| E7 | Phone field | Shows the caution: "Verify before publishing — an extracted number may belong to someone else." |

## F. Editing, Save Draft, Approve

| # | Step | Expected |
|---|---|---|
| F1 | Open a candidate, change nothing | **Save Draft is disabled** (nothing to save) |
| F2 | Edit the offer name | Save Draft enables |
| F3 | Click **Save Draft** | Button shows "Saving...", then the modal reloads with the saved value. **The candidate stays REVIEW_REQUIRED** and remains in the queue |
| F4 | Close and reopen the candidate | The edit persisted |
| F5 | Set offer price **above** original price | Red error "Offer price cannot be higher than the original price." Save Draft and Approve both disabled |
| F6 | Set end date before start date | Red error "End date must be after the start date." Both disabled |
| F7 | Edit only the offer price to exceed the *stored* original | Still blocked — the check uses stored values for untouched fields |
| F8 | Fix the values | Errors clear, buttons re-enable |
| F9 | Edit several offer **and** business fields, click **Approve & Publish** | Button reads "Approve & Publish (with edits)". Offer goes ACTIVE with every edit applied — including the business fields |
| F10 | Enter a phone number already used by another business, save | Clear 400: "Another business already uses this mobile number… check Business Duplicates" — **not** a server error |
| F11 | Reject a candidate | Unchanged from before |

## G. Duplicate detection (reused — regression check)

| # | Step | Expected |
|---|---|---|
| G1 | Import the *same* URL twice | The second candidate shows the amber duplicate banner with a match % and reasons |
| G2 | Read the banner | Names the suspected original offer and its business |
| G3 | Confirm nothing auto-merged | Both candidates still exist independently; approval is still your call |

## H. Access control

| # | Step | Expected |
|---|---|---|
| H1 | Log in as a **merchant**, try `/admin` | No admin dashboard; no AI Offer Discovery tab anywhere |
| H2 | As a merchant, call `POST /discovery/import` directly | 403 |
| H3 | As a merchant, call `PUT /discovery/candidates/:id/draft` directly | 403 |
| H4 | As a **customer**, confirm no imported draft is publicly visible | Candidates are DRAFT until approved — they must not appear in offer listings or search |

## I. Regression — nothing else moved

| # | Step | Expected |
|---|---|---|
| I1 | Discovered Offers tab | Filters, search, pagination, bulk approve/reject all work as before |
| I2 | The poster upload card inside Discovered Offers | Still present and working (it now shares the failure-message table) |
| I3 | Claim Requests tab | Unchanged |
| I4 | Business Duplicates tab | Unchanged |
| I5 | Shop Onboardings, Deals Moderation | Unchanged |

---

## Performance to note while testing

- Time from clicking **Analyze using AI** to the result (expected: a few
  seconds; the request blocks for the whole pipeline).
- Time from a poster upload to the row flipping to Done (OCR is the slow
  part; a large image can take 10–20s).
- Whether the recent-imports feed stops polling once everything is terminal
  — check the network tab.

## Reporting back

Pass / Fail per numbered item, with what you saw instead for any fail
(screenshot if easy, exact error text if not).

Part 1 now covers the pipeline, the API behind every review button, and
access control. **What genuinely remains is rendering and interaction** —
things that only exist in a browser:

| Still needed | Why it can't be verified below the browser |
|---|---|
| **A1–A5** import page rendering | React render output |
| **D2a–D2e** live feed + **polling stops** | `useEffect` teardown; only observable in a real network tab |
| **E1–E7** review modal layout | React render output |
| **F1, F2, F8** button enable/disable states | Component state, not API behavior |
| **F9** Approve applying edits | Not run on production — it would publish a live offer |

Everything else in sections B, C, D, F3–F7, F10, G and H is already confirmed
in Part 1. Re-running them in the browser is a bonus, not a gate.

There is **no React component-testing library in this repo** (`@testing-library/react`
is not installed — Vitest here has only ever run pure-logic units). Adding it
would be a dependency change I haven't been asked to make; say the word and
the rendering and polling items above become automatable.
