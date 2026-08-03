-- Brute-force lockout for the primary login/registration OTP flow.
-- Documentation of the schema applied via `prisma db push` (this project's
-- real sync mechanism; migration folders are kept as a readable history).
--
-- Mirrors ClaimRequest.otp_attempts exactly. Before this, POST
-- /auth/verify-otp had zero attempt limiting — a 6-digit OTP (1,000,000
-- combinations) could be guessed against a known mobile number with no
-- backend resistance at all.

ALTER TABLE "otp_verifications" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
