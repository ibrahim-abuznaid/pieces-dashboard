#!/usr/bin/env node
// One-off, kept for the record: adds the roster rows the archived weeks were
// MISSING, and restates every row's stage from the PR timestamps, on 2026-09-21.
//
// Same doctrine as scripts/backfill-ai-actions.mjs, which this follows and does
// not replace: a stage is decided by two timestamps per claim, `createdAt` and
// `mergedAt`, which GitHub records permanently and data/pr-states.json carries.
// "How many pieces had their agent atomics merged by Friday" has one correct
// answer and it is the same answer today as it was that Friday. This
// reconstructs; it does not estimate.
//
// What it was needed for. The earlier backfill could only restate rows the
// roster already had, and the roster is ai-actions/pieces.json — a curated list
// that nothing reconciles against the repo. Three faults had accumulated in it,
// two of which cancelled out in the total and so hid each other:
//   · pubrio and quizell were counted merged off #13979, but both were cut from
//     that PR before it merged; successor #14623 is closed unmerged.
//   · resend and sendinblue were still marked held on disk after both landed on
//     2026-09-17 (#15582, #15502).
//   · pinterest, tally, whatsscale and hubspot got agent atomics outside the
//     rollout and were never written down at all.
// The count read 26 for three straight weeks while the true figures were 25,
// 26 and 29. The live page was corrected in 2e3fddb; this carries the same
// correction back through the archive.
//
// ADDING a row is as reconstructible as restating one: a piece enters the
// roster at the week whose end its PR already existed for, and not before.
// Where no timestamp reaches back to a week — hubspot's #15542 was opened
// 2026-09-14, so it says nothing about W36 — the row is left out of that week
// rather than backdated to a stage it never held.
//
// `totalPieces` DOES move here, unlike in the earlier backfill, and only
// because rows move: the collector writes it as the roster's own size
// (weekly/collect/ai-actions.mjs reads summary.pieces, which is
// `enriched.length`), so a roster that grew by four with a totalPieces that did
// not would be internally inconsistent in a way no reader could resolve.
//
// One row-pair is a SIMPLIFICATION, not a reconstruction, and is the only
// place here that is: pubrio and quizell read `held` in every week, because
// `held` is curated and dateless. They were in fact inside an open PR for all
// of them — #13979 until it merged without them, then #14623 until kishanprmr
// closed it. A claim carries one `pr`, so the schema cannot say "open under a
// number that later dropped this piece"; `held` records the outcome that did
// hold every one of those weeks, which is that neither ever shipped. The cost
// is W31's PR-open count, 12 archived and 10 here.
//
// What it deliberately does NOT touch, for the same reasons as before:
//   · `catalogPieces` — the cloud catalog's size that week. Only knowable then.
//   · `blockersOpen`, `status` — curated or fixed, no dates.
//   · `builtAt` — when the week was originally built, which stays true.
// And a row whose claim has no timestamp bearing on the week keeps the stage
// the archive recorded: resend was genuinely held through W36 and W37, and its
// #15582 (opened 2026-09-16) must not erase that.
//
//   node scripts/backfill-ai-actions-roster.mjs [--apply]
//
// Prints the table and changes nothing without --apply.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive, writeArchive, validateSnapshot } from '../weekly/lib/archive.mjs';
import { readCatalogIndex } from '../weekly/collect/output-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const ARCHIVE = join(ROOT, 'weekly/data/weeks.json');
const { pieces: claims } = read('ai-actions/pieces.json');
const { prs } = read('data/pr-states.json');
const catalog = readCatalogIndex(read);

const bySlug = new Map(claims.map((c) => [c.slug, c]));

// Day-resolution, matching how the windows are stored (weekly/lib/isoweek.mjs
// writes YYYY-MM-DD). A PR merged ON the Friday counts for that week.
const onOrBefore = (iso, end) => typeof iso === 'string' && iso.slice(0, 10) <= end;

// The stage a claim was at when a week ended, or null for "no timestamp decides
// this" — an existing row keeps what the archive recorded, and a missing row
// stays missing.
function stageAt(claim, end) {
  if (!claim) return null;
  if (claim.held) return 'held';                 // curated, dateless: held then, held now
  const pr = claim.pr != null ? prs[claim.pr] : null;
  if (!pr) return null;
  if (onOrBefore(pr.mergedAt, end)) return 'merged';
  if (onOrBefore(pr.createdAt, end)) return 'pr-open';
  return null;                                   // this PR post-dates the week
}

// Built to the shape weekly/collect/ai-actions.mjs writes, so an added row is
// indistinguishable from one the snapshot would have produced that week —
// `name` stays the SLUG, which is the row's identity for the week-over-week
// diff in weekly/lib/view.mjs.
function rowFor(claim, stage) {
  const known = catalog.get(claim.slug);
  return {
    name: claim.slug,
    actions: claim.atomics,
    stage,
    ...(known?.displayName ? { displayName: known.displayName } : {}),
    logo: known?.logo ?? null,
  };
}

const apply = process.argv.includes('--apply');
const archive = readArchive(ARCHIVE);
if (!archive.weeks.length) throw new Error('empty archive — nothing to backfill');

for (const week of archive.weeks) {
  const ws = week.aiActions;
  if (ws?.status !== 'ok' || !Array.isArray(ws.roster)) {
    console.log(`${week.week}  skipped — no ok aiActions block with a roster`);
    continue;
  }
  const before = `merged ${ws.merged} / PR-open ${ws.prOpen} / assigned ${ws.assigned} / held ${ws.held} / tracked ${ws.totalPieces}`;

  let kept = 0;
  for (const row of ws.roster) {
    const stage = stageAt(bySlug.get(row.name), week.end);
    if (stage === null) { kept += 1; continue; }
    row.stage = stage;
  }

  const present = new Set(ws.roster.map((r) => r.name));
  const added = [];
  for (const claim of claims) {
    if (present.has(claim.slug)) continue;
    const stage = stageAt(claim, week.end);
    if (stage === null) continue;                // nothing dates this piece into this week
    ws.roster.push(rowFor(claim, stage));
    added.push(`${claim.slug}:${stage}`);
  }
  ws.roster.sort((a, b) => b.actions - a.actions || a.name.localeCompare(b.name));

  // Recounted from the roster the page derives its tiles from, so the two can
  // never disagree — the same guarantee ai-actions/build.mjs gives live.
  const count = (s) => ws.roster.filter((r) => r.stage === s).length;
  ws.merged = count('merged');
  ws.prOpen = count('pr-open');
  ws.assigned = count('assigned');
  ws.held = count('held');
  ws.totalPieces = ws.roster.length;

  const after = `merged ${ws.merged} / PR-open ${ws.prOpen} / assigned ${ws.assigned} / held ${ws.held} / tracked ${ws.totalPieces}`;
  const notes = [kept ? `${kept} kept as archived` : '', added.length ? `+${added.join(' +')}` : '']
    .filter(Boolean).join(', ');
  console.log(`${week.week} (…${week.end})  ${before}  →  ${after}${notes ? `  (${notes})` : ''}`);
  validateSnapshot(week);
}

if (!apply) {
  console.log('\ndry run — pass --apply to write weekly/data/weeks.json');
} else {
  writeArchive(ARCHIVE, archive);
  console.log('\n✓ weekly/data/weeks.json updated');
}
