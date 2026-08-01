import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntitlementRuleType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Admin-side configuration of the entitlement engine. Separated from
// EntitlementService so the read/decide path used on every unlock stays
// small and has no write methods on it at all.

interface UpsertPolicyInput {
  name: string;
  ruleType: EntitlementRuleType;
  rules?: Record<string, unknown>;
  appliesTo?: Record<string, unknown>;
  priority?: number;
  isActive?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
}

@Injectable()
export class EntitlementAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listPolicies() {
    return this.prisma.entitlementPolicy.findMany({
      orderBy: [{ priority: 'desc' }, { created_at: 'desc' }],
    });
  }

  async createPolicy(input: UpsertPolicyInput) {
    const data = this.validate(input);
    return this.prisma.entitlementPolicy.create({ data });
  }

  async updatePolicy(id: string, input: UpsertPolicyInput) {
    const existing = await this.prisma.entitlementPolicy.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Policy not found');
    return this.prisma.entitlementPolicy.update({
      where: { id },
      data: this.validate(input),
    });
  }

  async deletePolicy(id: string) {
    const existing = await this.prisma.entitlementPolicy.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Policy not found');
    // Audit rows deliberately keep no FK to the policy — they snapshot its
    // terms instead — so deleting a policy never destroys unlock history.
    await this.prisma.entitlementPolicy.delete({ where: { id } });
    return { deleted: true };
  }

  async listAudit(businessId?: string) {
    return this.prisma.leadUnlockAudit.findMany({
      where: businessId ? { business_id: businessId } : undefined,
      orderBy: { unlocked_at: 'desc' },
      take: 500,
    });
  }

  async grantCredits(
    input: {
      businessId: string;
      credits: number;
      reason: string;
      expiresAt?: string | null;
    },
    grantedBy: string,
  ) {
    if (input.credits === 0) {
      throw new BadRequestException('credits must be non-zero');
    }
    const business = await this.prisma.business.findUnique({
      where: { id: input.businessId },
      select: { id: true },
    });
    if (!business) throw new NotFoundException('Business not found');

    return this.prisma.entitlementGrant.create({
      data: {
        business_id: input.businessId,
        credits: input.credits,
        reason: input.reason,
        granted_by: grantedBy,
        expires_at: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    });
  }

  /**
   * Rejects policies that would be silently meaningless — a MONTHLY_QUOTA
   * with no positive limit blocks every unlock while *looking* like an
   * allowance, which is the kind of misconfiguration that only surfaces as
   * confused merchants.
   */
  private validate(input: UpsertPolicyInput): Prisma.EntitlementPolicyCreateInput {
    const rules = input.rules ?? {};

    if (input.ruleType === EntitlementRuleType.MONTHLY_QUOTA) {
      const limit = (rules as Record<string, unknown>).limit;
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
        throw new BadRequestException(
          'MONTHLY_QUOTA requires rules.limit to be a positive number, e.g. {"limit": 10}',
        );
      }
    }

    const startsAt = input.startsAt ? new Date(input.startsAt) : null;
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;
    if (startsAt && endsAt && endsAt <= startsAt) {
      throw new BadRequestException('endsAt must be after startsAt');
    }

    return {
      name: input.name,
      rule_type: input.ruleType,
      rules: rules as Prisma.InputJsonValue,
      applies_to: (input.appliesTo ?? {}) as Prisma.InputJsonValue,
      priority: input.priority ?? 0,
      is_active: input.isActive ?? true,
      starts_at: startsAt,
      ends_at: endsAt,
    };
  }
}
