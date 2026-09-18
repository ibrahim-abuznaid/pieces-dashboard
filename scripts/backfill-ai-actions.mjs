#!/usr/bin/env node
// One-off, kept for the record: restates the `aiActions` stage counts in the
// already-archived weeks from the PR timestamps, on 2026-09-18.
//
// Why this is a legitimate write to an otherwise immutable archive — the same
// argument as scripts/backfill-ui-improvements.mjs, for the same reason. A
// stage here is decided by two TIMESTAMPS per claim, `createdAt` and
// `mergedAt`, which GitHub records permanently and data/pr-states.json carries.
// "How many pieces had their agent atomics merged by Friday 2026-07-31" has one
// correct answer and it is the same answer today as it was that Friday. This
// reconstructs; it does not estimate.
//
// What it was needed for. Three claims (google-docs, google-calendar, gmail)
// pointed at PRs that closed unmerged and were re-opened under new numbers
// (#13926→#14519, #13929→#14520, #13930→#14565). The number still resolved, so
// the daily refresh stayed green while the POINTER was stale, and deriveStage()
// fell back to the closed PRs' assignees — reporting three finished pieces as
// `assigned` for six straight weeks. The archive faithfully froze that in.
//
// It corrects a SECOND, larger error in W31 as a side effect, which is worth
// knowing before reading the diff: that week was snapshotted on 2026-08-05 off a
// dist/ built from PR states fetched around 07-27, so it recorded 2 pieces
// merged when 14 had in fact merged by the Friday. Reading end-of-week state off
// a build that is only ever NOW is precisely the hazard both backfills exist to
// undo.
//
// What it deliberately does NOT touch, because no timestamp decides it:
//   · `catalogPieces` — the cloud catalog's size that week (756…765). Only ever
//     knowable then; today's 765 would silently restate six weeks of it.
//   · `blockersOpen`, `totalPieces`, `status` — curated or fixed, no dates.
//   · every roster row's `displayName`, `logo`, `actions` — display detail.
//   · `builtAt` — when the week was originally built, which stays true.
// And where a claim's PR did not exist yet at the week's end, the archived stage
// is KEPT rather than dropped: gmail's superseding #14565 was opened 2026-08-03,
// but its predecessor #13930 was genuinely open through W31, so W31's recorded
// `pr-open` is the true reading and this script must not erase it.
//
//   node scripts/backfill-ai-actions.mjs [--apply]
//
// Prints the table and changes nothing without --apply.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive, writeArchive, validateSnapshot } from '../weekly/lib/archive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const ARCHIVE = join(ROOT, 'weekly/data/weeks.json');
const { pieces: claims } = read('ai-actions/pieces.json');
const { prs } = read('data/pr-states.json');

const bySlug = new Map(claims.map((c) => [c.slug, c]));

// Day-resolution, matching how the windows are stored (weekly/lib/isoweek.mjs
// writes YYYY-MM-DD). A PR merged ON the Friday counts for that week.
const onOrBefore = (iso, end) => typeof iso === 'string' && iso.slice(0, 10) <= end;

// The stage a claim was at when a week ended, or null for "no timestamp decides
// this" — the caller keeps whatever the archive recorded.
function stageAt(claim, end) {
  if (!claim) return null;
  if (claim.held) return 'held';                 // curated, dateless: held then, held now
  const pr = claim.pr != null ? prs[claim.pr] : null;
  if (!pr) return null;
  if (onOrBefore(pr.mergedAt, end)) return 'merged';
  if (onOrBefore(pr.createdAt, end)) return 'pr-open';
  return null;                                   // this PR post-dates the week
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
  const before = `merged ${ws.merged} / PR-open ${ws.prOpen} / assigned ${ws.assigned} / held ${ws.held}`;
  let kept = 0;
  for (const row of ws.roster) {
    const stage = stageAt(bySlug.get(row.name), week.end);
    if (stage === null) { kept += 1; continue; }
    row.stage = stage;
  }
  // Recounted from the roster the build derives its tiles from, so the two can
  // never disagree — the same guarantee ai-actions/build.mjs gives live.
  const count = (s) => ws.roster.filter((r) => r.stage === s).length;
  ws.merged = count('merged');
  ws.prOpen = count('pr-open');
  ws.assigned = count('assigned');
  ws.held = count('held');
  const after = `merged ${ws.merged} / PR-open ${ws.prOpen} / assigned ${ws.assigned} / held ${ws.held}`;
  console.log(`${week.week} (…${week.end})  ${before}  →  ${after}${kept ? `  (${kept} row(s) kept as archived)` : ''}`);
  validateSnapshot(week);
}

if (!apply) {
  console.log('\ndry run — pass --apply to write weekly/data/weeks.json');
} else {
  writeArchive(ARCHIVE, archive);
  console.log('\n✓ weekly/data/weeks.json updated');
}
