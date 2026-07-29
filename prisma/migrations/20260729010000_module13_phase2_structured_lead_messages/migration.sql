-- Module 13 Phase 2 — Deal Coordination Assistant: structured lead messages
-- replace free text. Applied to production via `prisma db push` (this
-- project's established workflow). This file documents the applied change.

ALTER TABLE "lead_messages" ADD COLUMN "message_type" TEXT NOT NULL DEFAULT 'STATEMENT';
ALTER TABLE "lead_messages" ADD COLUMN "payload" JSONB;

-- The 2 existing free-text rows (from the original chat implementation)
-- backfill to message_type='STATEMENT' via the column default and keep
-- their original text unchanged — they still display exactly as before.
