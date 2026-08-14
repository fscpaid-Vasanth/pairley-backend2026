#!/usr/bin/env node
/**
 * Backfill Business.created_by_ai for existing rows that the AI Offers
 * From Online pipeline created before this flag existed on that write path.
 *
 *   node scripts/backfill-ai-business-flags.js            # dry run (default)
 *   node scripts/backfill-ai-business-flags.js --apply    # writes changes
 *
 * Safe to run repeatedly: a row already correctly flagged is skipped, so a
 * second run reports zero changes. Before writing anything, --apply
 * archives the full before-state of every affected row to scripts/archive/.
 *
 * Context: OfferDraftCreationService.matchOrCreateBusiness() — used by both
 * AiOffersFromOnlineService and OfferPublisherService — never set
 * created_by_ai: true before 2026-08-13, so every business the AI Offer
 * Collector's pipeline created (business_status UNCLAIMED, source ADMIN)
 * is indistinguishable in the database from one Offer Publisher's own
 * manual placeholder-business flow created, and from a genuine merchant
 * self-registration. Two consequences this script fixes:
 *   1. Admin -> Shop Onboardings incorrectly shows these AI-created rows
 *      (DashboardService.listBusinesses()/pendingApprovals now excludes
 *      created_by_ai: true + business_status: UNCLAIMED — but only for
 *      rows that actually carry the flag).
 *   2. The already-built claim flows (ClaimRequestService.claimPublicOffer/
 *      getClaimEligibility, AuthService.absorbUnclaimedAiBusiness) require
 *      created_by_ai === true to recognize a business as claimable — these
 *      businesses are currently invisible to both.
 *
 * `source = 'ADMIN'` alone cannot identify AI origin — Offer Publisher's
 * own placeholder businesses use the same value. The only reliable proof a
 * Business came from the AI Collector is a matching AiOfferFromOnline row
 * that references it via matched_business_id or created_business_id — that
 * linkage is the join this script uses.
 *
 * This ONLY sets created_by_ai = true on matched rows. Nothing is deleted,
 * deactivated, or touched on the AiOfferFromOnline side — there is no
 * separate "onboarding record" to remove; Shop Onboardings is a filtered
 * view of Business, not its own table, so flipping this one flag is the
 * complete, trivially reversible fix.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();

const APPLY = process.argv.includes('--apply');

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows: plan } = await client.query(`
    SELECT DISTINCT b.id, b.business_name, b.business_status, b.created_at
    FROM businesses b
    JOIN ai_offers_from_online a
      ON a.matched_business_id = b.id OR a.created_business_id = b.id
    WHERE b.business_status = 'UNCLAIMED'
      AND b.created_by_ai = false
    ORDER BY b.created_at
  `);

  console.log(`\n${APPLY ? 'APPLY' : 'DRY RUN'} — created_by_ai backfill\n`);

  if (plan.length === 0) {
    console.log('No changes needed. Every AI-linked UNCLAIMED business is already flagged.');
    await client.end();
    return;
  }

  console.log('Businesses to flag as created_by_ai = true:');
  console.table(plan.map((r) => ({ id: r.id, business_name: r.business_name, created_at: r.created_at })));
  console.log(`Total rows to update: ${plan.length}`);

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to write these changes.\n');
    await client.end();
    return;
  }

  const archiveDir = path.join(__dirname, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(
    archiveDir,
    `ai-business-flags-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(archivePath, JSON.stringify(plan, null, 2));
  console.log(`\nBefore-state archived to: ${archivePath}`);

  await client.query('BEGIN');
  try {
    for (const row of plan) {
      await client.query('UPDATE businesses SET created_by_ai = true WHERE id = $1', [row.id]);
    }
    await client.query('COMMIT');
    console.log(`Committed ${plan.length} row updates.\n`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Rolled back — no changes written:', err.message);
    process.exitCode = 1;
  }

  await client.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
