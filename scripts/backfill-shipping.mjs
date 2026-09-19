#!/usr/bin/env node
// Reconstructs the `shipping` workstream for weeks already in the archive.
//
// weeks.json is immutable because almost everything on this page is only
// knowable NOW: a cloud catalog, an open PR, a Linear queue. Recomputing an old
// week with today's version of those would restate it, which is why a missed
// Saturday stays missed.
//
// This workstream is the exception, on the same grounds as
// backfill-ui-improvements.mjs: both numbers are functions of timestamps that
// have already happened. "How many PRs did the team merge between 2026-08-08
// and 2026-08-14" has one correct answer and it does not drift, and the weekly
// review buckets are stamped with the week they belong to. Re-deriving them is
// reading history, not rewriting it.
//
// Bounded by the internal dashboard's own rolling window: a week outside it
// cannot be reconstructed and is LEFT ALONE rather than written as zero, which
// is the same distinction the collector's freshness gate makes at snapshot time.
//
// The strip is the one part that does not come back. `recentPrs` is capped
// upstream at the most recent handful, so a reconstructed week gets its true
// counts and an empty list. A missing strip under a true number is the honest
// shape; the alternative is a number trimmed to the length of a list.
//
// Usage: node scripts/backfill-shipping.mjs [--write]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive, writeArchive } from '../weekly/lib/archive.mjs';
import { collectShipping } from '../weekly/collect/shipping.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = join(ROOT, 'weekly/data/weeks.json');
const TEAM_DASHBOARD = process.env.PIECES_TEAM_DASHBOARD
  ?? '/home/ibrahim/AP_work/Activepieces_v/pieces-team/dashboard';

const readTeamJson = (name) => JSON.parse(readFileSync(join(TEAM_DASHBOARD, 'data', name), 'utf8'));
const write = process.argv.includes('--write');

const github = readTeamJson('github.json');
const covered = (github.mergedEvents ?? []).reduce(
  (acc, e) => ({ min: e.d < acc.min ? e.d : acc.min, max: e.d > acc.max ? e.d : acc.max }),
  { min: '9999-99-99', max: '0000-00-00' },
);
console.log(`github.json stamped ${github.stamp}, merge events span ${covered.min}..${covered.max}`);

const archive = readArchive(ARCHIVE);
let changed = 0;

for (const week of archive.weeks) {
  if (week.shipping?.status === 'ok') {
    console.log(`  ${week.week}  already recorded — left alone`);
    continue;
  }
  // The window has to sit entirely inside what the pull actually walked. A week
  // that only partly overlaps would come back as a real-looking undercount,
  // which is worse than the blank it has now.
  if (week.start < covered.min) {
    console.log(`  ${week.week}  starts ${week.start}, before the pull's earliest event — skipped`);
    continue;
  }
  const out = collectShipping({
    window: { start: week.start, end: week.end },
    weekId: week.week,
    readJson: readTeamJson,
  });
  if (out.status !== 'ok') {
    console.log(`  ${week.week}  ${out.reason}`);
    continue;
  }
  const people = Object.entries(out.byPerson).filter(([, n]) => n > 0).map(([p, n]) => `${p} ${n}`);
  console.log(`  ${week.week}  ${out.prsMerged} PRs (${out.piecePrs} piece) · ${out.reviews} reviews · ${people.join(', ') || 'nobody'}`);
  week.shipping = out;
  changed += 1;
}

if (!write) {
  console.log(`\n${changed} week(s) would change. Re-run with --write to apply.`);
  process.exit(0);
}
writeArchive(ARCHIVE, archive);
console.log(`\n✓ wrote ${changed} week(s) to weekly/data/weeks.json`);
