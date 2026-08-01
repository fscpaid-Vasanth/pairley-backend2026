import { Injectable, Logger } from '@nestjs/common';
import { EntitlementRuleType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Decides whether a merchant may unlock a lead's contact details.
//
// Deliberately knows nothing about Lead, Offer or Business internals — it is
// handed a business id and returns a verdict. That is what lets pricing and
// packaging change without touching those entities: LeadService asks
// "may this business unlock?" and never learns why the answer is what it is.
//
// Nothing here is hard-coded. Limits, eligibility, campaign windows and the
// standing default are all rows in EntitlementPolicy, editable from the admin
// dashboard. A promotional campaign is just a higher-priority policy with an
// end date; when it lapses the next-highest policy takes over on the very next
// evaluation, with no deploy and no scheduled job.

export interface EntitlementDecision {
  allowed: boolean;
  /** Machine-readable, for UI branching. */
  reason:
    | 'UNLIMITED'
    | 'WITHIN_QUOTA'
    | 'CREDITS_AVAILABLE'
    | 'QUOTA_EXCEEDED'
    | 'NO_CREDITS'
    | 'BLOCKED'
    | 'NO_POLICY';
  /** Human-facing, safe to show a merchant verbatim. */
  message: string;
  policy: {
    id: string;
    name: string;
    ruleType: EntitlementRuleType;
    rules: Prisma.JsonValue;
    endsAt: Date | null;
  } | null;
  /** Remaining unlocks where the model is countable; null when unlimited. */
  remaining: number | null;
  /** True while a time-boxed promotional policy is the one in force. */
  isPromotional: boolean;
}

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the single policy in force for a business right now.
   *
   * Selection is: active, inside its time window, eligibility satisfied,
   * highest priority first. Ties break on most-recently-created so a newly
   * added campaign at the same priority takes precedence over a stale one.
   */
  async resolvePolicy(businessId: string) {
    const now = new Date();

    const candidates = await this.prisma.entitlementPolicy.findMany({
      where: {
        is_active: true,
        AND: [
          { OR: [{ starts_at: null }, { starts_at: { lte: now } }] },
          { OR: [{ ends_at: null }, { ends_at: { gt: now } }] },
        ],
      },
      orderBy: [{ priority: 'desc' }, { created_at: 'desc' }],
    });

    if (candidates.length === 0) return null;

    // Eligibility needs the business record only if some candidate actually
    // asks about it — most evaluations skip this query entirely.
    const needsBusiness = candidates.some((p) => {
      const a = (p.applies_to ?? {}) as Record<string, unknown>;
      return a.verifiedOnly === true;
    });
    const business = needsBusiness
      ? await this.prisma.business.findUnique({
          where: { id: businessId },
          select: { id: true, verification_status: true },
        })
      : null;

    for (const policy of candidates) {
      if (this.matchesEligibility(policy.applies_to, businessId, business)) {
        return policy;
      }
    }
    return null;
  }

  private matchesEligibility(
    appliesTo: Prisma.JsonValue,
    businessId: string,
    business: { verification_status: string } | null,
  ): boolean {
    const rules = (appliesTo ?? {}) as Record<string, unknown>;

    if (Array.isArray(rules.businessIds)) {
      if (!(rules.businessIds as string[]).includes(businessId)) return false;
    }

    if (rules.verifiedOnly === true) {
      if (!business || business.verification_status !== 'APPROVED') return false;
    }

    // Unknown keys are intentionally ignored rather than failing closed: a
    // policy authored against a newer build must never lock merchants out of
    // an older one still running.
    return true;
  }

  /**
   * The decision itself. Read-only — it never records anything, so callers
   * can safely use it to render UI state as well as to gate the action.
   */
  async evaluate(businessId: string): Promise<EntitlementDecision> {
    const policy = await this.resolvePolicy(businessId);

    if (!policy) {
      // Fail closed. An unconfigured system must not silently give away
      // contact details it may later intend to charge for.
      return {
        allowed: false,
        reason: 'NO_POLICY',
        message:
          'Lead unlocking is not currently available. Please contact support.',
        policy: null,
        remaining: null,
        isPromotional: false,
      };
    }

    const summary = {
      id: policy.id,
      name: policy.name,
      ruleType: policy.rule_type,
      rules: policy.rules,
      endsAt: policy.ends_at,
    };
    const isPromotional = policy.ends_at !== null;

    switch (policy.rule_type) {
      case EntitlementRuleType.UNLIMITED:
        return {
          allowed: true,
          reason: 'UNLIMITED',
          message: policy.name,
          policy: summary,
          remaining: null,
          isPromotional,
        };

      case EntitlementRuleType.BLOCKED:
        return {
          allowed: false,
          reason: 'BLOCKED',
          message:
            'Unlocking customer details requires an active plan on your account.',
          policy: summary,
          remaining: 0,
          isPromotional,
        };

      case EntitlementRuleType.MONTHLY_QUOTA: {
        const limit = this.readNumber(policy.rules, 'limit', 0);
        const used = await this.countUnlocksThisMonth(businessId);
        const remaining = Math.max(0, limit - used);
        return {
          allowed: remaining > 0,
          reason: remaining > 0 ? 'WITHIN_QUOTA' : 'QUOTA_EXCEEDED',
          message:
            remaining > 0
              ? `${remaining} of ${limit} monthly unlocks remaining.`
              : `You have used all ${limit} unlocks included this month.`,
          policy: summary,
          remaining,
          isPromotional,
        };
      }

      case EntitlementRuleType.CREDITS: {
        const balance = await this.creditBalance(businessId);
        return {
          allowed: balance > 0,
          reason: balance > 0 ? 'CREDITS_AVAILABLE' : 'NO_CREDITS',
          message:
            balance > 0
              ? `${balance} lead credit${balance === 1 ? '' : 's'} remaining.`
              : 'You have no lead credits remaining.',
          policy: summary,
          remaining: balance,
          isPromotional,
        };
      }

      default:
        // An unrecognised rule type means this build is older than the
        // policy. Fail closed rather than guessing at the intent.
        this.logger.warn(
          `[Entitlement] Unrecognised rule_type "${String(policy.rule_type)}" on policy ${policy.id} — denying.`,
        );
        return {
          allowed: false,
          reason: 'NO_POLICY',
          message:
            'Lead unlocking is not currently available. Please contact support.',
          policy: summary,
          remaining: null,
          isPromotional,
        };
    }
  }

  /**
   * Writes the audit row for an unlock that has been authorised. Snapshots
   * the policy terms so the record stays truthful after the policy is later
   * edited, renamed or deleted.
   */
  async recordUnlock(params: {
    leadId: string;
    businessId: string;
    actorId: string;
    actorRole: 'BUSINESS' | 'ADMIN';
    decision: EntitlementDecision;
    tx?: Prisma.TransactionClient;
  }): Promise<void> {
    const { leadId, businessId, actorId, actorRole, decision, tx } = params;
    const client = tx ?? this.prisma;

    await client.leadUnlockAudit.create({
      data: {
        lead_id: leadId,
        business_id: businessId,
        actor_id: actorId,
        actor_role: actorRole,
        policy_id: decision.policy?.id ?? null,
        policy_name: decision.policy?.name ?? 'No policy',
        policy_rule_type:
          decision.policy?.ruleType ?? EntitlementRuleType.UNLIMITED,
        policy_snapshot: {
          reason: decision.reason,
          rules: decision.policy?.rules ?? {},
          remainingBefore: decision.remaining,
          endsAt: decision.policy?.endsAt?.toISOString() ?? null,
        } as Prisma.InputJsonValue,
      },
    });
  }

  /** Unlock history for a business, newest first. */
  async listAuditForBusiness(businessId: string, limit = 100) {
    return this.prisma.leadUnlockAudit.findMany({
      where: { business_id: businessId },
      orderBy: { unlocked_at: 'desc' },
      take: limit,
    });
  }

  private async countUnlocksThisMonth(businessId: string): Promise<number> {
    const now = new Date();
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    return this.prisma.leadUnlockAudit.count({
      where: {
        business_id: businessId,
        unlocked_at: { gte: periodStart },
        // Only unlocks actually charged against a quota count toward it —
        // ones granted free by a promotional campaign must not silently eat
        // the merchant's paid allowance once the campaign ends.
        policy_rule_type: EntitlementRuleType.MONTHLY_QUOTA,
      },
    });
  }

  private async creditBalance(businessId: string): Promise<number> {
    const now = new Date();
    const [granted, spent] = await Promise.all([
      this.prisma.entitlementGrant.aggregate({
        where: {
          business_id: businessId,
          OR: [{ expires_at: null }, { expires_at: { gt: now } }],
        },
        _sum: { credits: true },
      }),
      this.prisma.leadUnlockAudit.count({
        where: {
          business_id: businessId,
          policy_rule_type: EntitlementRuleType.CREDITS,
        },
      }),
    ]);
    return (granted._sum.credits ?? 0) - spent;
  }

  private readNumber(
    rules: Prisma.JsonValue,
    key: string,
    fallback: number,
  ): number {
    const obj = (rules ?? {}) as Record<string, unknown>;
    const value = obj[key];
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : fallback;
  }
}
