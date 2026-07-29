-- Module 13 Phase 2b — guided-workflow sections + analytics event log.
-- Applied to production via `prisma db push` (this project's established
-- workflow). This file documents the applied change.

CREATE TABLE "lead_interaction_events" (
    "id"           TEXT NOT NULL,
    "lead_id"      TEXT NOT NULL,
    "sender_role"  TEXT NOT NULL,
    "template_key" TEXT NOT NULL,
    "event_type"   TEXT NOT NULL,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_interaction_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lead_interaction_events_lead_id_created_at_idx" ON "lead_interaction_events"("lead_id", "created_at");
CREATE INDEX "lead_interaction_events_event_type_created_at_idx" ON "lead_interaction_events"("event_type", "created_at");

-- No column changes to lead_messages — the "guided workflow" restructuring
-- (Quick Actions / Schedule / Location / Offer Status) is entirely a
-- catalog-layer change (leadMessageTemplates.ts) plus this new event log;
-- LeadMessage's shape from Phase 2 is unchanged.
