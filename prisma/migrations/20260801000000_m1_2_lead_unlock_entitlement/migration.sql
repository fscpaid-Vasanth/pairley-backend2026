-- M1.2 — Lead Unlock Entitlement Engine
--
-- Documentation of the schema applied via `prisma db push` (this project's
-- real sync mechanism; migration folders are kept as a readable history).
--
-- Design intent: this is meant to be the LAST schema change lead-unlock
-- monetisation ever needs. Limits, eligibility, campaign windows and pricing
-- all live in entitlement_policies.rules/applies_to as JSON, editable from the
-- admin dashboard. New monetisation models are new rule shapes, not new tables.

CREATE TYPE "EntitlementRuleType" AS ENUM ('UNLIMITED', 'MONTHLY_QUOTA', 'CREDITS', 'BLOCKED');

CREATE TABLE "entitlement_policies" (
    "id"         TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "rule_type"  "EntitlementRuleType" NOT NULL,
    "rules"      JSONB NOT NULL DEFAULT '{}',
    "applies_to" JSONB NOT NULL DEFAULT '{}',
    "priority"   INTEGER NOT NULL DEFAULT 0,
    "is_active"  BOOLEAN NOT NULL DEFAULT true,
    "starts_at"  TIMESTAMP(3),
    "ends_at"    TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "entitlement_policies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "entitlement_policies_is_active_priority_idx" ON "entitlement_policies"("is_active", "priority");

-- Doubles as the consumption ledger: monthly-quota usage is COUNT(*) over a
-- period here, so quotas need no separate counter table to drift out of sync.
-- policy_name/policy_rule_type/policy_snapshot are denormalised on purpose —
-- a policy may later be renamed, re-tuned or deleted, and the audit trail must
-- still state truthfully which terms applied at the moment of the unlock.
CREATE TABLE "lead_unlock_audit" (
    "id"               TEXT NOT NULL,
    "lead_id"          TEXT NOT NULL,
    "business_id"      TEXT NOT NULL,
    "actor_id"         TEXT NOT NULL,
    "actor_role"       TEXT NOT NULL,
    "policy_id"        TEXT,
    "policy_name"      TEXT NOT NULL,
    "policy_rule_type" "EntitlementRuleType" NOT NULL,
    "policy_snapshot"  JSONB NOT NULL DEFAULT '{}',
    "unlocked_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lead_unlock_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lead_unlock_audit_business_id_unlocked_at_idx" ON "lead_unlock_audit"("business_id", "unlocked_at");
CREATE INDEX "lead_unlock_audit_lead_id_idx" ON "lead_unlock_audit"("lead_id");

-- Credit balance is SUM(credits) - COUNT(audit rows spent under a CREDITS
-- policy), so credits behave as an append-only ledger with no mutable balance
-- column that could drift or be corrupted by a partial write.
CREATE TABLE "entitlement_grants" (
    "id"          TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "credits"     INTEGER NOT NULL,
    "reason"      TEXT NOT NULL,
    "granted_by"  TEXT NOT NULL,
    "expires_at"  TIMESTAMP(3),
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "entitlement_grants_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "entitlement_grants_business_id_expires_at_idx" ON "entitlement_grants"("business_id", "expires_at");
