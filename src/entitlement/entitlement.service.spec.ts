import { EntitlementRuleType } from '@prisma/client';
import { EntitlementService } from './entitlement.service';

// The behaviour that matters most here is the automatic hand-back: when the
// launch campaign lapses, merchants must fall through to the standing default
// with no deploy, no scheduled job and no code change. That is asserted
// directly below rather than being assumed from the schema.

describe('EntitlementService', () => {
  let policyFindMany: jest.Mock;
  let businessFindUnique: jest.Mock;
  let auditCount: jest.Mock;
  let auditCreate: jest.Mock;
  let auditFindMany: jest.Mock;
  let grantAggregate: jest.Mock;
  let prisma: any;
  let service: EntitlementService;

  const policy = (over: Partial<any> = {}) => ({
    id: 'pol-1',
    name: 'Test Policy',
    rule_type: EntitlementRuleType.UNLIMITED,
    rules: {},
    applies_to: {},
    priority: 0,
    is_active: true,
    starts_at: null,
    ends_at: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ...over,
  });

  beforeEach(() => {
    policyFindMany = jest.fn().mockResolvedValue([]);
    businessFindUnique = jest
      .fn()
      .mockResolvedValue({ id: 'biz-1', verification_status: 'APPROVED' });
    auditCount = jest.fn().mockResolvedValue(0);
    auditCreate = jest.fn().mockResolvedValue({});
    auditFindMany = jest.fn().mockResolvedValue([]);
    grantAggregate = jest.fn().mockResolvedValue({ _sum: { credits: 0 } });

    prisma = {
      entitlementPolicy: { findMany: policyFindMany },
      business: { findUnique: businessFindUnique },
      leadUnlockAudit: {
        count: auditCount,
        create: auditCreate,
        findMany: auditFindMany,
      },
      entitlementGrant: { aggregate: grantAggregate },
    };
    service = new EntitlementService(prisma);
  });

  describe('fail-closed defaults', () => {
    it('denies when no policy is configured at all', async () => {
      const d = await service.evaluate('biz-1');
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('NO_POLICY');
    });

    it('denies rather than guessing when the rule type is unrecognised', async () => {
      // Simulates this build being older than the policy that was authored.
      policyFindMany.mockResolvedValue([
        policy({ rule_type: 'SOME_FUTURE_MODEL' as any }),
      ]);
      const d = await service.evaluate('biz-1');
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('NO_POLICY');
    });
  });

  describe('launch campaign — the M1.2 headline behaviour', () => {
    const campaign = policy({
      id: 'campaign',
      name: 'Diwali Launch Benefit',
      rule_type: EntitlementRuleType.UNLIMITED,
      applies_to: { verifiedOnly: true },
      priority: 100,
      ends_at: new Date('2026-11-15'),
    });
    const standard = policy({
      id: 'standard',
      name: 'Standard Plan',
      rule_type: EntitlementRuleType.MONTHLY_QUOTA,
      rules: { limit: 10 },
      priority: 0,
    });

    it('lets the campaign outrank the standing default while it is live', async () => {
      // The DB query filters expired policies out; while live, both return.
      policyFindMany.mockResolvedValue([campaign, standard]);
      const d = await service.evaluate('biz-1');

      expect(d.allowed).toBe(true);
      expect(d.reason).toBe('UNLIMITED');
      expect(d.policy?.name).toBe('Diwali Launch Benefit');
      expect(d.isPromotional).toBe(true);
      expect(d.remaining).toBeNull();
    });

    it('falls back to the default automatically once the campaign has expired', async () => {
      // Post-expiry the campaign no longer satisfies the ends_at filter, so
      // only the default comes back — no deploy, no job, no code change.
      policyFindMany.mockResolvedValue([standard]);
      const d = await service.evaluate('biz-1');

      expect(d.allowed).toBe(true);
      expect(d.reason).toBe('WITHIN_QUOTA');
      expect(d.policy?.name).toBe('Standard Plan');
      expect(d.isPromotional).toBe(false);
      expect(d.remaining).toBe(10);
    });

    it('excludes unverified merchants from the campaign, falling through to the default', async () => {
      businessFindUnique.mockResolvedValue({
        id: 'biz-1',
        verification_status: 'PENDING',
      });
      policyFindMany.mockResolvedValue([campaign, standard]);
      const d = await service.evaluate('biz-1');

      expect(d.policy?.name).toBe('Standard Plan');
    });

    it('marks a policy promotional only when it has an end date', async () => {
      policyFindMany.mockResolvedValue([standard]);
      expect((await service.evaluate('biz-1')).isPromotional).toBe(false);
    });
  });

  describe('eligibility targeting', () => {
    it('honours an explicit business allowlist', async () => {
      policyFindMany.mockResolvedValue([
        policy({ id: 'vip', name: 'VIP', applies_to: { businessIds: ['other'] } }),
        policy({ id: 'base', name: 'Base' }),
      ]);
      const d = await service.evaluate('biz-1');
      expect(d.policy?.name).toBe('Base');
    });

    it('matches when the business is on the allowlist', async () => {
      policyFindMany.mockResolvedValue([
        policy({
          id: 'vip',
          name: 'VIP',
          priority: 50,
          applies_to: { businessIds: ['biz-1'] },
        }),
        policy({ id: 'base', name: 'Base' }),
      ]);
      const d = await service.evaluate('biz-1');
      expect(d.policy?.name).toBe('VIP');
    });

    it('ignores unknown eligibility keys instead of failing closed', async () => {
      // A policy authored against a newer build must not lock merchants out
      // of an older one still running.
      policyFindMany.mockResolvedValue([
        policy({ applies_to: { somethingFromTheFuture: true } }),
      ]);
      expect((await service.evaluate('biz-1')).allowed).toBe(true);
    });

    it('skips the business lookup entirely when no policy asks about verification', async () => {
      policyFindMany.mockResolvedValue([policy()]);
      await service.evaluate('biz-1');
      expect(businessFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('MONTHLY_QUOTA', () => {
    const quota = policy({
      rule_type: EntitlementRuleType.MONTHLY_QUOTA,
      rules: { limit: 3 },
    });

    it('allows while under the limit and reports what is left', async () => {
      policyFindMany.mockResolvedValue([quota]);
      auditCount.mockResolvedValue(1);
      const d = await service.evaluate('biz-1');
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(2);
    });

    it('denies once the limit is reached', async () => {
      policyFindMany.mockResolvedValue([quota]);
      auditCount.mockResolvedValue(3);
      const d = await service.evaluate('biz-1');
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('QUOTA_EXCEEDED');
      expect(d.remaining).toBe(0);
    });

    it('counts only quota-charged unlocks, not free promotional ones', async () => {
      // Otherwise a merchant who unlocked freely all through the launch
      // campaign would find their first paid month already exhausted.
      policyFindMany.mockResolvedValue([quota]);
      await service.evaluate('biz-1');
      expect(auditCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            policy_rule_type: EntitlementRuleType.MONTHLY_QUOTA,
          }),
        }),
      );
    });

    it('treats a missing limit as zero and denies, rather than allowing everything', async () => {
      policyFindMany.mockResolvedValue([
        policy({ rule_type: EntitlementRuleType.MONTHLY_QUOTA, rules: {} }),
      ]);
      const d = await service.evaluate('biz-1');
      expect(d.allowed).toBe(false);
    });
  });

  describe('CREDITS', () => {
    const credits = policy({ rule_type: EntitlementRuleType.CREDITS });

    it('allows while the granted balance exceeds what has been spent', async () => {
      policyFindMany.mockResolvedValue([credits]);
      grantAggregate.mockResolvedValue({ _sum: { credits: 5 } });
      auditCount.mockResolvedValue(2);
      const d = await service.evaluate('biz-1');
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(3);
    });

    it('denies at a zero balance', async () => {
      policyFindMany.mockResolvedValue([credits]);
      grantAggregate.mockResolvedValue({ _sum: { credits: 2 } });
      auditCount.mockResolvedValue(2);
      const d = await service.evaluate('biz-1');
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('NO_CREDITS');
    });

    it('excludes expired grants from the balance', async () => {
      policyFindMany.mockResolvedValue([credits]);
      await service.evaluate('biz-1');
      const where = grantAggregate.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { expires_at: null },
        { expires_at: { gt: expect.any(Date) } },
      ]);
    });
  });

  describe('BLOCKED', () => {
    it('denies with a message safe to show the merchant', async () => {
      policyFindMany.mockResolvedValue([
        policy({ rule_type: EntitlementRuleType.BLOCKED }),
      ]);
      const d = await service.evaluate('biz-1');
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('BLOCKED');
      expect(d.message).toMatch(/active plan/i);
    });
  });

  describe('audit trail', () => {
    it('snapshots the policy terms rather than only referencing the policy', async () => {
      // A policy can later be renamed, re-tuned or deleted; the record must
      // still say truthfully which terms applied at the time.
      await service.recordUnlock({
        leadId: 'lead-1',
        businessId: 'biz-1',
        actorId: 'biz-1',
        actorRole: 'BUSINESS',
        decision: {
          allowed: true,
          reason: 'UNLIMITED',
          message: 'Diwali Launch Benefit',
          policy: {
            id: 'campaign',
            name: 'Diwali Launch Benefit',
            ruleType: EntitlementRuleType.UNLIMITED,
            rules: { note: 'launch' },
            endsAt: new Date('2026-11-15'),
          },
          remaining: null,
          isPromotional: true,
        },
      });

      const data = auditCreate.mock.calls[0][0].data;
      expect(data).toMatchObject({
        lead_id: 'lead-1',
        business_id: 'biz-1',
        actor_id: 'biz-1',
        actor_role: 'BUSINESS',
        policy_id: 'campaign',
        policy_name: 'Diwali Launch Benefit',
        policy_rule_type: EntitlementRuleType.UNLIMITED,
      });
      expect(data.policy_snapshot).toMatchObject({
        reason: 'UNLIMITED',
        rules: { note: 'launch' },
      });
    });

    it('still records an unlock performed with no policy in force', async () => {
      await service.recordUnlock({
        leadId: 'lead-2',
        businessId: 'biz-1',
        actorId: 'admin-9',
        actorRole: 'ADMIN',
        decision: {
          allowed: true,
          reason: 'UNLIMITED',
          message: '',
          policy: null,
          remaining: null,
          isPromotional: false,
        },
      });
      expect(auditCreate.mock.calls[0][0].data).toMatchObject({
        policy_id: null,
        policy_name: 'No policy',
        actor_role: 'ADMIN',
      });
    });
  });
});
