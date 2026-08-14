#!/usr/bin/env node
/**
 * Reclassify existing ai_offers_from_online rows stuck in PRICE_REQUIRED,
 * now that price is no longer a publish gate (2026-08-14 — see
 * ai-offers-from-online.service.ts).
 *
 *   node scripts/reclassify-price-required-offers.js            # dry run (default)
 *   node scripts/reclassify-price-required-offers.js --apply    # writes changes
 *
 * Safe to run repeatedly: once no row is PRICE_REQUIRED, a second run
 * reports zero changes. Before writing anything, --apply archives the full
 * before-state of every affected row to scripts/archive/.
 *
 * Context: publish() used to refuse an offer with a null offer_price,
 * persisting status = PRICE_REQUIRED. That gate is gone — offer_price is
 * now optional, and a null price becomes a 0 sentinel on the real, live
 * Offer instead (never a fabricated number; see the code comment at the
 * Offer.create() call site for why 0 is safe there). Any row still sitting
 * in PRICE_REQUIRED from before this change needs to re-enter the normal
 * queue so an admin can review and publish it — every one of these rows
 * already has the fields importExportedOffer() has always required
 * (non-empty merchant name, offer title, address, banner), so none of them
 * are missing "genuine offer information", only a number that was never
 * actually required. This script does NOT publish anything itself — it
 * only returns each row to PENDING_ADMIN_REVIEW, exactly where a normal
 * export lands, so the existing admin review/publish flow decides what
 * happens next.
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
    SELECT id, merchant_name, offer_title, failure_reason, exported_at
    FROM ai_offers_from_online
    WHERE status = 'PRICE_REQUIRED'
    ORDER BY exported_at
  `);

  console.log(`\n${APPLY ? 'APPLY' : 'DRY RUN'} — PRICE_REQUIRED reclassification\n`);

  if (plan.length === 0) {
    console.log('No changes needed. No offer is currently PRICE_REQUIRED.');
    await client.end();
    return;
  }

  console.log('Offers to move to PENDING_ADMIN_REVIEW:');
  console.table(
    plan.map((r) => ({ id: r.id, merchant_name: r.merchant_name, offer_title: r.offer_title, exported_at: r.exported_at })),
  );
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
    `price-required-reclassify-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(archivePath, JSON.stringify(plan, null, 2));
  console.log(`\nBefore-state archived to: ${archivePath}`);

  await client.query('BEGIN');
  try {
    for (const row of plan) {
      await client.query(
        `UPDATE ai_offers_from_online SET status = 'PENDING_ADMIN_REVIEW', failure_reason = NULL WHERE id = $1`,
        [row.id],
      );
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
