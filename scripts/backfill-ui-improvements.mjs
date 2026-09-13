#!/usr/bin/env node
// One-off, kept for the record: adds the `uiImprovements` block to the weeks
// that were archived before the workstream existed.
//
// Why this is a legitimate write to an otherwise immutable archive. Every other
// collector reads state that is only knowable NOW — dist/ builds from today's
// catalog, a tester's coverage, a ticket board — so recomputing an old week
// would silently restate it with today's numbers. This workstream is different:
// its stages are decided by two TIMESTAMPS per claim, `createdAt` and
// `mergedAt`, which GitHub records permanently and data/pr-states.json now
// carries. Asking "how many pieces had the new property UI merged by 2026-09-04"
// has one correct answer, and it is the same answer today as it was that Friday.
//
// So this script reconstructs, it does not estimate. What it deliberately does
// NOT write is `live`: whether a merged piece was published on cloud that week
// is not in any timestamp we hold, and the archive makes `live` optional
// precisely so a reconstructed week can stay silent about it rather than guess.
// A week with no `live` simply contributes no "merged but not live" ask.
//
//   node scripts/backfill-ui-improvements.mjs [--apply]
//
// Prints the table and changes nothing without --apply.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive, writeArchive, validateSnapshot } from '../weekly/lib/archive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const ARCHIVE = join(ROOT, 'weekly/data/weeks.json');
const { pieces: claims } = read('ui-improvements/pieces.json');
const { prs } = read('data/pr-states.json');
const catalog = read('output-schema/data/cloud-catalog.json');
const rosterNow = read('dist/ui-improvements/pieces.json').pieces;

// The catalog as it is today, used only for a piece's NAME and LOGO. Both are
// display detail with no date attached — a piece renamed since W31 renders under
// the name it has now, which is the name the reader recognises.
const byFolder = new Map(rosterNow.map((r) => [r.folder, r]));
const catalogSize = catalog.length;

// A day-resolution comparison against the week's last day, matching how the
// windows themselves are stored (weekly/lib/isoweek.mjs writes YYYY-MM-DD).
const onOrBefore = (iso, end) => typeof iso === 'string' && iso.slice(0, 10) <= end;

// The stage a claim was at when a week ended. `merged` and nothing narrower —
// see the header: cloud state is not reconstructable, so no row is ever written
// as `live` here.
function stageAt(claim, end) {
  const pr = claim.pr != null ? prs[claim.pr] : null;
  if (!pr) return null;
  if (onOrBefore(pr.mergedAt, end)) return 'merged';
  if (onOrBefore(pr.createdAt, end)) return 'review';
  return null;    // the PR did not exist yet: the piece was not in this week
}

function blockFor(end) {
  const roster = [];
  for (const claim of claims) {
    const stage = stageAt(claim, end);
    if (!stage) continue;
    const now = byFolder.get(claim.slug);
    roster.push({
      folder: claim.slug,
      name: claim.slug,
      displayName: now?.displayName ?? null,
      actions: now?.steps ?? 0,
      stage,
      logo: now?.logoUrl ?? null,
    });
  }
  roster.sort((a, b) => b.actions - a.actions || a.name.localeCompare(b.name));
  const count = (s) => roster.filter((r) => r.stage === s).length;
  return {
    status: 'ok',
    merged: count('merged'),
    review: count('review'),
    // Nobody was recorded as claiming a piece without opening a PR in any of
    // these weeks, and a claim date is not a thing GitHub stores — so this is a
    // measured 0, not an unmeasured one.
    assigned: 0,
    totalPieces: catalogSize,
    roster,
  };
}

const apply = process.argv.includes('--apply');
const archive = readArchive(ARCHIVE);
if (!archive.weeks.length) throw new Error('empty archive — nothing to backfill');

for (const week of archive.weeks) {
  const block = blockFor(week.end);
  const had = week.uiImprovements ? 'already present, replaced' : 'added';
  console.log(`${week.week} (…${week.end})  merged ${block.merged}  review ${block.review}  · ${had}`);
  week.uiImprovements = block;
  validateSnapshot(week);
}

if (!apply) {
  console.log('\ndry run — pass --apply to write weekly/data/weeks.json');
} else {
  writeArchive(ARCHIVE, archive);
  console.log('\n✓ weekly/data/weeks.json updated');
}
