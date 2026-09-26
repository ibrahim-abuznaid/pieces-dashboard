#!/usr/bin/env node
// One-off, kept for the record: counts the AI-actions PRs Ibrahim approved on
// 2026-09-26 as done in W39, the week the work was finished.
//
// This is the one restatement in scripts/ that is a DECISION rather than a
// reconstruction, and it says so. The other backfills only ever apply a rule to
// timestamps GitHub keeps. Here the approvals are stamped 2026-09-26 15:39–15:43Z,
// the morning after W39 closed on Friday 09-25, so a strict reading puts them in
// W40. The team lead's call: every one of these PRs was opened and finished in
// W39 (#15661 09-20, #15696 09-21, #15725/#15757 09-23; #15585 09-16 and
// reworked since), approval is the end of the team's part -- the merge button is
// his -- and a weekly report that credits the work to the week after it was done
// misreports both weeks. Counting them in W39 also keeps W40 honest: the diff in
// weekly/lib/view.mjs treats `approved` as done, so they will not be reported
// again when they merge.
//
// What moves: rows the archive recorded as `pr-open` whose PR is OPEN and
// APPROVED today become `approved`, and the counts are recomputed from the
// roster. Nothing else -- merged rows, held rows, `actions`, `catalogPieces`,
// `builtAt` -- is touched.
//
//   node scripts/backfill-ai-actions-approved.mjs [--week 2026-W39] [--apply]
//
// Run `npm run fetch:prs` first: the approvals are read from data/pr-states.json.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive, writeArchive, validateSnapshot } from '../weekly/lib/archive.mjs';
import { claimedPr } from '../lib/discover.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

const WEEK = arg('--week') ?? '2026-W39';
const apply = process.argv.includes('--apply');

const { prs } = read('data/pr-states.json');
const { pieces: curated } = read('ai-actions/pieces.json');
const discovered = read('data/discovered-claims.json').aiActions ?? {};
const curatedPr = new Map(curated.map((p) => [p.slug, p.pr ?? null]));

const ARCHIVE = join(ROOT, 'weekly/data/weeks.json');
const archive = readArchive(ARCHIVE);
const week = archive.weeks.find((w) => w.week === WEEK);
if (!week) throw new Error(`${WEEK} is not in the archive`);
const ws = week.aiActions;
if (ws?.status !== 'ok' || !Array.isArray(ws.roster)) throw new Error(`${WEEK} has no ok aiActions roster`);

const before = `merged ${ws.merged} / approved ${ws.approved ?? 0} / PR-open ${ws.prOpen}`;
const moved = [];
for (const row of ws.roster) {
  if (row.stage !== 'pr-open') continue;
  const pr = claimedPr(curatedPr.get(row.name) ?? null, discovered, row.name);
  const st = pr != null ? prs[pr] : null;
  if (st?.state === 'OPEN' && st.approved === true) {
    row.stage = 'approved';
    moved.push(`${row.name} (#${pr}, approved ${st.approvedAt})`);
  }
}

const count = (s) => ws.roster.filter((r) => r.stage === s).length;
ws.merged = count('merged');
ws.approved = count('approved');
ws.prOpen = count('pr-open');
ws.assigned = count('assigned');
ws.held = count('held');
ws.totalPieces = ws.roster.length;
validateSnapshot(week);

console.log(`${WEEK}  ${before}  →  merged ${ws.merged} / approved ${ws.approved} / PR-open ${ws.prOpen}`);
for (const m of moved) console.log(`    approved: ${m}`);
if (!apply) {
  console.log('\ndry run — pass --apply to write weekly/data/weeks.json');
} else {
  writeArchive(ARCHIVE, archive);
  console.log('\n✓ weekly/data/weeks.json updated');
}
