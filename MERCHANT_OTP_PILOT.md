# Merchant Onboarding OTP Pilot

Temporary, config-flagged bypass that replaces real SMS OTP verification with
a fixed 4-digit code, scoped to the merchant (`role: 'Business'`) flow only.
Purpose: remove SMS delivery friction/cost during the MVP merchant pilot.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `MERCHANT_OTP_MODE` | `production` (safe default when unset) | `test` enables the fixed-OTP bypass for `role: 'Business'` requests. Any other value (including a typo) falls back to the real OTP flow. |
| `MERCHANT_DEFAULT_OTP` | `1234` | The fixed code accepted while `MERCHANT_OTP_MODE=test`. |

Set on Render under the backend service's Environment tab. Not present in
`.env.example` (there isn't one in this repo) — set directly, same as every
other secret/flag here.

**To fully revert to the real OTP flow: set `MERCHANT_OTP_MODE=production`
(or remove the var) and redeploy. No code changes required in either
direction** — this was an explicit requirement.

## Scope — what is and isn't affected

- Only requests carrying `role: 'Business'` to `POST /auth/send-otp` /
  `POST /auth/verify-otp` are affected. `role: 'Customer'`, admin login
  (which doesn't use OTP at all), and Firebase Authentication are
  untouched — verified by tests in `auth.service.spec.ts` under "Merchant
  OTP pilot bypass".
- Frontend callers that send `role: 'Business'`: the Merchant Sign Up panel
  and Merchant Login (OTP tab) on `SignUpPage.jsx` / `LoginPage.jsx`, plus
  the Google-account merchant onboarding step on `LoginPage.jsx`.
- **`MerchantQuickJoin.jsx`** (the Launch Pass "quick join" lead-capture
  flow at `/merchant/quick-join` or similar) is a **separate, pre-existing
  flow** that was found to already have its own ad-hoc, undocumented OTP
  bypass (`TEST_NUMBERS`, prefix-matching, and a permanently-visible
  "Use Default OTP: 123456" banner shown to every visitor). It does not use
  this `MERCHANT_OTP_MODE` flag and was intentionally left unmodified — it
  writes to a Firestore leads collection, not a real Business account, so
  it's a lower-stakes but separate issue. Flagged for a future cleanup
  decision, not addressed here.

## Security scope — read before enabling on a shared/production environment

`sendOtp()` / `verifyOtp()` in `auth.service.ts` are the **same code path**
for both new merchant registration and returning-merchant login — whichever
of `Business`/`Customer` already has a matching mobile number gets logged in
directly with a JWT. This means while `MERCHANT_OTP_MODE=test` is active,
**the fixed code authenticates against any mobile number in the merchant
flow, including an already-approved merchant's account** — not just
first-time signups. Anyone who knows or guesses a merchant's registered
mobile number can log into that merchant's live dashboard without needing
the SMS.

This was an explicit, informed scope decision made for the pilot period
(the alternative — restricting the bypass to first-time registrations only
— was offered and declined in favor of covering login too, for pilot
testing speed). It is not a code defect. Re-evaluate before extending the
pilot period or opening merchant signup to an untrusted audience.

## Rollback

Nothing here is structural — no schema change, no new tables. Reverting is
a single env var flip. `S3StorageProvider`/`FirebaseStorageProvider` and the
Storage migration flag are unrelated and unaffected by this feature.
