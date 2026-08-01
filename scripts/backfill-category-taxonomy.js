#!/usr/bin/env node
/**
 * Backfill every stored category onto the canonical taxonomy.
 *
 *   node scripts/backfill-category-taxonomy.js            # dry run (default)
 *   node scripts/backfill-category-taxonomy.js --apply    # writes changes
 *
 * Safe to run repeatedly: rows already canonical are skipped, so a second
 * run reports zero changes. Before writing anything, --apply archives the
 * full before-state of every affected row to scripts/archive/, which is
 * the rollback path (there is no shadow column — for a table this size an
 * archive file is simpler and equally recoverable).
 *
 * Rows whose value cannot be resolved are reported as UNRESOLVED and left
 * untouched — the script never guesses. Fix the taxonomy or the alias map
 * and re-run.
 *
 * Context: Offer.category and Business.category accumulated a mix of
 * canonical keys ('fitness'), display names ('Shopping') and an
 * out-of-taxonomy literal ('General'). The frontend hid this behind a
 * .toLowerCase() on read, but every backend GROUP BY category would have
 * split one market into several — which Market Price Intelligence depends
 * on being correct.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();

// Mirrors src/common/taxonomy/category-taxonomy.ts. Kept as a literal copy
// rather than importing the .ts so this script stays runnable with plain
// node against any environment, including a production shell with no
// build step available. category.service.spec.ts asserts the two agree.
const CANONICAL_KEYS = [
  'shopping', 'tours', 'dining', 'fitness', 'entertainment', 'education',
  'beauty', 'subscriptions', 'adventure', 'home-services', 'healthcare',
  'coworking', 'general',
];
const DISPLAY_NAMES = {
  'shopping': 'shopping', 'tour packages': 'tours', 'dining and food': 'dining',
  'dining & food': 'dining', 'fitness and gym': 'fitness', 'fitness & gym': 'fitness',
  'events and entertainment': 'entertainment', 'events & entertainment': 'entertainment',
  'education and courses': 'education', 'education & courses': 'education',
  'beauty and spa': 'beauty', 'beauty & spa': 'beauty',
  'subscriptions and ott': 'subscriptions', 'subscriptions & ott': 'subscriptions',
  'adventure and sports': 'adventure', 'adventure & sports': 'adventure',
  'home services': 'home-services', 'healthcare': 'healthcare',
  'co-working and stays': 'coworking', 'co-working & stays': 'coworking',
  'uncategorized': 'general',
};
const ALIASES = {
  gym: 'fitness', gyms: 'fitness', health: 'healthcare', medical: 'healthcare',
  food: 'dining', restaurant: 'dining', restaurants: 'dining', travel: 'tours',
  tour: 'tours', trips: 'tours', salon: 'beauty', spa: 'beauty',
  events: 'entertainment', movies: 'entertainment', courses: 'education',
  retail: 'shopping', shop: 'shopping', ott: 'subscriptions',
  subscription: 'subscriptions', sports: 'adventure', home: 'home-services',
  coliving: 'coworking', 'co working': 'coworking', uncategorised: 'general',
  other: 'general', misc: 'general',
};

function normalize(raw) {
  if (raw === null || raw === undefined) return 'general';
  const trimmed = String(raw).trim();
  if (trimmed === '') return 'general';
  if (CANONICAL_KEYS.includes(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  if (CANONICAL_KEYS.includes(lower)) return lower;
  if (DISPLAY_NAMES[lower]) return DISPLAY_NAMES[lower];

  const collapsed = lower.replace(/\s*&\s*/g, ' and ').replace(/\s+/g, ' ');
  if (DISPLAY_NAMES[collapsed]) return DISPLAY_NAMES[collapsed];
  if (ALIASES[collapsed]) return ALIASES[collapsed];
  if (ALIASES[lower]) return ALIASES[lower];

  const slug = lower.replace(/\s*&\s*/g, '-').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (CANONICAL_KEYS.includes(slug)) return slug;
  if (ALIASES[slug]) return ALIASES[slug];

  return null; // unresolved — never guessed
}

const APPLY = process.argv.includes('--apply');

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const targets = [
    { table: 'offers', label: 'Offer' },
    { table: 'businesses', label: 'Business' },
  ];

  const plan = [];
  const unresolved = [];

  for (const { table, label } of targets) {
    const { rows } = await client.query(
      `SELECT id, category FROM ${table} ORDER BY id`,
    );
    for (const row of rows) {
      const next = normalize(row.category);
      if (next === null) {
        unresolved.push({ table, label, id: row.id, category: row.category });
        continue;
      }
      if (next !== row.category) {
        plan.push({ table, label, id: row.id, from: row.category, to: next });
      }
    }
  }

  console.log(`\n${APPLY ? 'APPLY' : 'DRY RUN'} — category taxonomy backfill\n`);

  if (unresolved.length > 0) {
    console.log('UNRESOLVED — left untouched, needs an alias or a fix:');
    console.table(unresolved);
  }

  if (plan.length === 0) {
    console.log('No changes needed. Every stored category is already canonical.');
    await client.end();
    return;
  }

  const summary = plan.reduce((acc, c) => {
    const k = `${c.label}: "${c.from}" -> "${c.to}"`;
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  console.log('Planned changes:');
  console.table(
    Object.entries(summary).map(([change, rows]) => ({ change, rows })),
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
    `category-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(archivePath, JSON.stringify(plan, null, 2));
  console.log(`\nBefore-state archived to: ${archivePath}`);

  // One transaction — a partial backfill would leave the data in a worse,
  // half-normalised state than it started in.
  await client.query('BEGIN');
  try {
    for (const change of plan) {
      await client.query(
        `UPDATE ${change.table} SET category = $1 WHERE id = $2`,
        [change.to, change.id],
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
