#!/usr/bin/env node
/**
 * Seeds the two policies the entitlement engine needs to be operational.
 *
 *   node scripts/seed-entitlement-policies.js                      # dry run
 *   node scripts/seed-entitlement-policies.js --apply
 *   node scripts/seed-entitlement-policies.js --apply --campaign-ends=2026-11-16
 *
 * 1. "Diwali Launch Benefit" — UNLIMITED, priority 100, ends on the campaign
 *    date. Verified merchants unlock freely for the whole launch window.
 * 2. "Standard Plan" — the standing default at priority 0, with no end date.
 *
 * Because the campaign has an end date and outranks the default, the hand-back
 * is automatic: the moment `ends_at` passes, the campaign stops matching and
 * the next evaluation falls through to the default. No scheduled job, no
 * deploy, no code change.
 *
 * Nothing here is hard-coded into the application — this script only creates
 * the initial rows. Every value, including the campaign end date and what the
 * default becomes, is editable afterwards from the admin dashboard.
 *
 * The default seeds as UNLIMITED rather than a quota deliberately: switching
 * merchants from "free" to "blocked" should be an explicit, deliberate act in
 * the admin UI, not something that happens by surprise because a seed script
 * chose a paywall. Change rule_type to MONTHLY_QUOTA (with {"limit":N}) or
 * BLOCKED when the commercial model is decided.
 *
 * Idempotent: policies are matched by name, so re-running updates rather than
 * duplicating.
 */
const { Client } = require('pg');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');

// Default campaign end: Diwali launch date + one week of grace. Overridable
// via --campaign-ends=YYYY-MM-DD, and editable in the admin UI afterwards.
const endsArg = process.argv.find((a) => a.startsWith('--campaign-ends='));
const CAMPAIGN_ENDS = endsArg
  ? new Date(`${endsArg.split('=')[1]}T23:59:59+05:30`)
  : new Date('2026-11-15T23:59:59+05:30');

if (Number.isNaN(CAMPAIGN_ENDS.getTime())) {
  console.error('Invalid --campaign-ends value. Use YYYY-MM-DD.');
  process.exit(1);
}

const POLICIES = [
  {
    name: 'Diwali Launch Benefit',
    rule_type: 'UNLIMITED',
    rules: {},
    // Verified merchants only. Unverified accounts should not be able to
    // pull real customer phone numbers before anyone has checked who they
    // are, campaign or not.
    applies_to: { verifiedOnly: true },
    priority: 100,
    is_active: true,
    starts_at: null,
    ends_at: CAMPAIGN_ENDS,
  },
  {
    name: 'Standard Plan',
    rule_type: 'UNLIMITED',
    rules: {},
    applies_to: {},
    priority: 0,
    is_active: true,
    starts_at: null,
    ends_at: null,
  },
];

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(`\n${APPLY ? 'APPLY' : 'DRY RUN'} — entitlement policy seed`);
  console.log(`Campaign ends: ${CAMPAIGN_ENDS.toISOString()}\n`);

  const plan = [];
  for (const p of POLICIES) {
    const { rows } = await client.query(
      'SELECT id FROM entitlement_policies WHERE name = $1',
      [p.name],
    );
    plan.push({
      name: p.name,
      action: rows.length ? 'update' : 'create',
      rule: p.rule_type,
      priority: p.priority,
      ends: p.ends_at ? p.ends_at.toISOString().slice(0, 10) : 'never',
      eligibility: JSON.stringify(p.applies_to),
      id: rows[0]?.id ?? null,
    });
  }
  console.table(plan.map(({ id, ...rest }) => rest));

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to write.\n');
    await client.end();
    return;
  }

  await client.query('BEGIN');
  try {
    for (let i = 0; i < POLICIES.length; i++) {
      const p = POLICIES[i];
      const existingId = plan[i].id;
      if (existingId) {
        await client.query(
          `UPDATE entitlement_policies
             SET rule_type = $1, rules = $2, applies_to = $3, priority = $4,
                 is_active = $5, starts_at = $6, ends_at = $7, updated_at = now()
           WHERE id = $8`,
          [p.rule_type, p.rules, p.applies_to, p.priority, p.is_active,
           p.starts_at, p.ends_at, existingId],
        );
      } else {
        await client.query(
          `INSERT INTO entitlement_policies
             (id, name, rule_type, rules, applies_to, priority, is_active,
              starts_at, ends_at, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, now(), now())`,
          [p.name, p.rule_type, p.rules, p.applies_to, p.priority,
           p.is_active, p.starts_at, p.ends_at],
        );
      }
    }
    await client.query('COMMIT');
    console.log('\nSeeded successfully.\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Rolled back:', err.message);
    process.exitCode = 1;
  }

  await client.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
