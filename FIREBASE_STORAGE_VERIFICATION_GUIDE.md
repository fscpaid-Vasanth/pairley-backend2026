# Firebase Storage — Local Live Verification Guide

Storage Migration Phase 1. Run this entirely on your own machine — your
Firebase service account credential never needs to leave it. This guide
assumes the backend at `d:\Ai Tech Boss - Digital Flow Company\Pairley V4\backend`
and (optionally, for a few steps) the frontend at
`d:\Ai Tech Boss - Digital Flow Company\Pairley Web and Mobile App`.

---

## 1. Setup

### 1.1 Place your credentials — pick ONE of these two options

**Option A — file (matches the existing FCM push-notification setup):**

Save the JSON key Firebase gave you as:

```
d:\Ai Tech Boss - Digital Flow Company\Pairley V4\backend\firebase-service-account.json
```

This exact filename/path is already in `.gitignore` (two entries:
`firebase-service-account.json` and the wildcard `*-service-account.json`),
so `git status` will never show it and it can't be accidentally committed.

**Option B — environment variable** (if you'd rather not have the key as a
loose file at all): open `.env` and add one line —

```
FIREBASE_SERVICE_ACCOUNT_JSON=<paste the entire JSON key here, all on one line>
```

If the raw JSON is awkward to paste on one line (the `private_key` field
has embedded newlines that can confuse `.env` parsing), base64-encode the
whole file first and paste that instead — the app tries raw JSON first,
then falls back to base64 automatically:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\your-downloaded-key.json")) | Set-Clipboard
```

Then paste the clipboard contents as the value of
`FIREBASE_SERVICE_ACCOUNT_JSON` in `.env`. `.env` is already gitignored.

If both are set, the environment variable wins.

### 1.2 Set the two flags that actually switch storage over

In `.env` (both already present with `s3`/`false`-safe defaults — just change these two values):

```
STORAGE_PROVIDER=firebase
USE_MOCK_STORAGE=false
```

`FIREBASE_STORAGE_BUCKET` is already set to `pairley2026-4706e.firebasestorage.app`
— no change needed there.

**To switch back to S3 at any point**, set `STORAGE_PROVIDER=s3` and restart
— nothing else needs to change, and both providers keep working side by
side throughout (per your instruction — nothing about S3 support is
touched by any of this).

### 1.3 Start the backend

```powershell
cd "d:\Ai Tech Boss - Digital Flow Company\Pairley V4\backend"
npm run start:dev
```

Wait for `Nest application successfully started` in the console. The
server listens on **port 3000**.

### 1.4 Confirm Firebase Storage actually initialized

This is the one thing I changed specifically to make this step possible
without reading logs — `/api/health` now reports which provider is active:

```powershell
curl http://localhost:3000/api/health
```

**Success looks like:**
```json
{
  "status": "ok",
  "checks": { "database": "ok", "storage": "ok" },
  "storageProvider": "firebase",
  "release": "...",
  ...
}
```

If `storageProvider` doesn't say `"firebase"`, the env vars in step 1.2
didn't take — double check `.env` was saved and the server was restarted
(env vars are only read at process start).

If `storageProvider: "firebase"` but `checks.storage: "unreachable"`,
you'll also see a `storageError` field with the actual reason — see the
troubleshooting table at the end of this guide before going further.

---

## 2. Getting a JWT to test the authenticated endpoints

Most of the checklist below needs a **Business** JWT (for your own
uploads) and one needs an **Admin** JWT (for document preview). Two ways
to get them:

**Easiest — use the real app.** Point the frontend at your local backend:

```powershell
cd "d:\Ai Tech Boss - Digital Flow Company\Pairley Web and Mobile App"
```
Edit `.env`: comment out the `VITE_API_URL=https://pairley-backend2026.onrender.com/api`
line and uncomment `# VITE_API_URL=http://localhost:3000/api` (both lines
already exist, just swap which is active). Then:
```powershell
npm run dev
```
Log in normally (as a merchant, or as admin) in the browser. Open DevTools
→ Application → Local Storage → `pairley_token` — that's your JWT, copy it
for any curl commands below.

**Or — register a disposable test business directly:**
```powershell
curl -X POST http://localhost:3000/api/business/register `
  -H "Content-Type: application/json" `
  -d '{\"role\":\"Business\",\"mobile\":\"9000001234\",\"name\":\"Firebase Test Owner\",\"business_name\":\"Firebase Verification Test Shop\"}'
```
This returns the created business record — you'll then need to log in
(`POST /api/auth/login` or however your normal login flow works) to get a
token, since `register` itself doesn't return one for the Business role in
this code path.

---

## 3. Verification checklist

For every item: do the action, then confirm the resulting URL in the
response/database looks like
`https://firebasestorage.googleapis.com/v0/b/pairley2026-4706e.firebasestorage.app/o/...`
(not `...s3.ap-south-1.amazonaws.com...`), and **cross-check in the
Firebase Console → Storage tab** that the file actually landed in the
bucket at the path you'd expect.

> **One thing worth knowing going in**: `POST /api/business/register`'s
> `shop_photo` field (in the simple registration branch) stores whatever
> value is passed directly into the database column — it does **not**
> call the storage layer at all. That's pre-existing behavior, unrelated
> to this migration, and out of scope to change right now. So for
> verifying photo uploads actually go through Firebase, use
> `upload-documents`/`media` below (both confirmed to call the storage
> layer for real) rather than the photo fields on `register` itself.

### ☐ Merchant registration
```powershell
curl -X POST http://localhost:3000/api/business/register `
  -H "Content-Type: application/json" `
  -d '{\"role\":\"Business\",\"mobile\":\"9000005678\",\"name\":\"Test Owner\",\"business_name\":\"Verification Shop\"}'
```
**Expect:** `201`, a business object with `business_status: "CLAIMED"`.
No storage interaction here — this just confirms the account layer works
unaffected by the storage flag.

### ☐ Shop photo upload
```powershell
curl -X POST http://localhost:3000/api/business/upload-documents `
  -H "Authorization: Bearer <your Business JWT>" `
  -F "shop_photo=@C:\path\to\any-test-photo.jpg"
```
**Expect:** the returned `shop_photo` field is a
`https://firebasestorage.googleapis.com/...` URL. Backend log line:
`[Firebase Storage] Uploaded file to: https://firebasestorage.googleapis.com/v0/b/.../o/documents%2F...`
Check Firebase Console → Storage → the object should be under `documents/`.

### ☐ Aadhaar upload
```powershell
curl -X POST http://localhost:3000/api/business/upload-documents `
  -H "Authorization: Bearer <your Business JWT>" `
  -F "aadhaar=@C:\path\to\any-test-id-photo.jpg"
```
**Expect:** same as above — `aadhaar_photo` field gets a Firebase URL
under `documents/`.

### ☐ PAN upload
```powershell
curl -X POST http://localhost:3000/api/business/upload-documents `
  -H "Authorization: Bearer <your Business JWT>" `
  -F "pan=@C:\path\to\any-test-id-photo.jpg"
```
**Expect:** `pan_photo` field gets a Firebase URL under `documents/`.

*(All three of the above can also go in a single request — the endpoint
accepts `shop_photo`, `aadhaar`, `pan`, `gst` together.)*

### ☐ Offer image upload
Requires an existing offer you own (create one via the app UI, or
`POST /api/offers/create` first). Then:
```powershell
curl -X POST http://localhost:3000/api/offers/<offerId>/media `
  -H "Authorization: Bearer <your Business JWT>" `
  -F "cover_image=@C:\path\to\any-test-photo.jpg"
```
**Expect:** `cover_image` becomes a Firebase URL under `offers/cover`.

### ☐ Claim evidence upload
Public endpoint, no auth needed — needs an UNCLAIMED business id (any
existing one, or create a disposable one directly in the DB with
`business_status: UNCLAIMED` the same way I did during my own testing):
```powershell
curl -X POST http://localhost:3000/api/business/claim/request `
  -H "Content-Type: application/json" `
  -d '{\"business_id\":\"<some UNCLAIMED business id>\",\"mobile\":\"9000009999\",\"claimant_name\":\"Test Claimant\",\"evidence\":[\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=\"]}'
```
**Expect:** `evidence_urls` in the resulting `ClaimRequest` row (check via
the admin Claim Requests panel, or the DB directly) is a Firebase URL
under `claim-evidence/`.

### ☐ Poster/PDF upload
Requires an Admin JWT.
```powershell
curl -X POST http://localhost:3000/api/discovery/import-file `
  -H "Authorization: Bearer <your Admin JWT>" `
  -F "file=@C:\path\to\any-test-poster.jpg"
```
**Expect:** `202`, an `ImportJob`. The job's `source_url` (once processing
finishes — check `GET /api/discovery/jobs/:id`) is a Firebase URL under
`discovery/`.

### ☐ Document download / admin document preview
Requires an Admin JWT. Use one of the Firebase URLs you confirmed above:
```powershell
curl "http://localhost:3000/api/business/document-preview?url=<url-encoded Firebase URL>" `
  -H "Authorization: Bearer <your Admin JWT>" `
  --output test-download.jpg
```
**Expect:** `test-download.jpg` is saved and opens as a real image — this
confirms the *read* side works too, not just uploads.

*(Update: the proxy now recognizes both S3 and Firebase Storage URLs and
routes each to the correct provider automatically — the compatibility gap
noted in the original version of this guide is closed, so this step now
works identically for both providers, no special-casing or manual
redirect-following needed. Verified live against the real S3 bucket: an
S3 URL still reaches the S3 provider exactly as before, an external
non-storage URL still redirects unchanged, and a Firebase-shaped URL now
correctly routes to the Firebase provider instead of redirecting.)*

### ☐ `/api/health`
Already covered in step 1.4 — re-run it here as the final check after
you've done a few uploads, to confirm `status: "ok"` (not just
`storageProvider` being right, but the reachability check itself passing
too, now that real objects exist in the bucket).

### ☐ Upload/download performance comparison

Simple side-by-side using curl's built-in timing:

```powershell
# With STORAGE_PROVIDER=firebase (current)
curl -w "`nTotal time: %{time_total}s`n" -X POST http://localhost:3000/api/business/upload-documents -H "Authorization: Bearer <token>" -F "shop_photo=@C:\path\to\test-photo.jpg" -o firebase-result.json

# Then edit .env, set STORAGE_PROVIDER=s3, restart the server, and repeat:
curl -w "`nTotal time: %{time_total}s`n" -X POST http://localhost:3000/api/business/upload-documents -H "Authorization: Bearer <token>" -F "shop_photo=@C:\path\to\test-photo.jpg" -o s3-result.json
```

Run each 3-5 times (network/cold-start variance is real) and compare the
average `time_total`. Do the same pattern for a download via
`document-preview` (now works for both providers) if you want a read-side
comparison too.

---

## 4. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `storageProvider` in `/api/health` still says `"s3"` | `.env` change didn't take | Confirm you saved `.env`, confirm you restarted the server (env vars load once at boot) |
| `storageError: "No Firebase credentials found — set FIREBASE_SERVICE_ACCOUNT_JSON or place firebase-service-account.json at the project root..."` | Neither credential option from step 1.1 is actually in place | Re-check the exact file path (must be the backend project root, not a subfolder) or the env var name (must be exactly `FIREBASE_SERVICE_ACCOUNT_JSON`) |
| `storageError: "FIREBASE_SERVICE_ACCOUNT_JSON is set but is neither valid JSON nor valid base64-encoded JSON"` | The pasted value got mangled (line breaks, partial copy) | Re-copy the full JSON, or regenerate the base64 version with the PowerShell one-liner in step 1.1 |
| Upload succeeds but the returned URL still says `amazonaws.com` | `STORAGE_PROVIDER` is still `s3`, or `USE_MOCK_STORAGE` is `true` (mock mode never touches either cloud provider — writes to local `uploads/` and returns a `/uploads/...` path instead) | Confirm both `.env` values from step 1.2, restart |
| `Firebase Storage upload failed: ...` with a permission-related message | The service account doesn't have Storage write access, or Storage hasn't been enabled for this project yet in the Firebase Console | Check Firebase Console → Storage — if you've never opened the Storage tab before, it may need a one-time "Get Started" click to actually provision the bucket, even though the bucket name is already configured in the app |
| Health check `ok: false` with a bucket-not-found-style message | `FIREBASE_STORAGE_BUCKET` value doesn't match the real bucket name | Confirm the exact bucket name in Firebase Console → Storage → the bucket name shown there, compare against `.env`'s `FIREBASE_STORAGE_BUCKET` |
| `document-preview` returns `404` with `"Unrecognized storage URL: ..."` | The URL isn't a recognized S3 or Firebase Storage URL shape | Double-check you copied the full URL correctly (including the `?alt=media&token=...` query string for Firebase URLs) |

---

## What to send back

For each checklist item: pass/fail, the resulting URL, and (for the
performance section) your timing numbers. Screenshots of the Firebase
Console Storage tab showing the uploaded files land in the right
`documents/` / `offers/cover/` / `claim-evidence/` / `discovery/` paths
are the most useful evidence. I'll fold all of it into the final
verification report once you share it back.
