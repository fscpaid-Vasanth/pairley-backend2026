-- Module 13 — WhatsApp-free interest flow: lead unlock + anonymous 1:1 chat.
-- Applied to production via `prisma db push` (this project's established
-- workflow — no `_prisma_migrations` tracking table exists in this
-- database). This file documents the applied change; it is not itself
-- executed by `migrate deploy`.

-- Lead: unlock gate + hard duplicate-interest guarantee
ALTER TABLE "leads" ADD COLUMN "unlocked_at" TIMESTAMP(3);
CREATE UNIQUE INDEX "leads_customer_id_offer_id_key" ON "leads"("customer_id", "offer_id");

-- LeadMessage: 1:1 anonymous chat thread, one per Lead
CREATE TABLE "lead_messages" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "sender_role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lead_messages_lead_id_created_at_idx" ON "lead_messages"("lead_id", "created_at");

ALTER TABLE "lead_messages" ADD CONSTRAINT "lead_messages_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
