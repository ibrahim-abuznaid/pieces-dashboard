#!/usr/bin/env node
// scripts/backfill-qa-sweeps.mjs
// Restates the `qaSweeps` block of archived weeks from the internal
// dashboard's data/qa.json, the way backfill-ui-improvements.mjs restated
// the weeks archived before that workstream existed.
//
// Two readings (weekly/collect/qa-sweeps.mjs). Every week in the range gets
// the DATES-ONLY reading as of its own last day: a ticket exists from
// createdAt, is fixed from completedAt, canceled from canceledAt, and no board
// state is claimed — a past day's queue and assignment are not knowable. With
// --live-latest the NEWEST week in the archive gets the LIVE reading instead,
// as a heal of that week would have: the board as it stands when this runs.
// Use it only when the file was read within days of that week's end.
//
// Usage:
//   node scripts/backfill-qa-sweeps.mjs --weeks=2026-W31..2026-W45 [--live-latest] [--force] [--apply] [--verbose]
//
// Dry run by default: prints one line per week and writes nothing. Fail-loud
// and all-or-nothing: a week that does not validate stops the run before the
// archive is touched. A week that already carries a qaSweeps block is KEPT
// unless --force: a block the Saturday collector wrote holds the board state
// of that week (assigned, in review, open), which no later run can rebuild,
// and a backfill over a range that happens to include it must not trade that
// for a dates-only restatement. backfill-connection-identifier.mjs has the
// same guard for the same reason.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive, writeArchive, validateSnapshot } from '../weekly/lib/archive.mjs';
import { qaSweepsForWindow } from '../weekly/collect/qa-sweeps.mjs';
import { windowForWeekId } from '../lib/isoweek.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = join(ROOT, 'weekly/data/weeks.json');
const TEAM_DASHBOARD = process.env.PIECES_TEAM_DASHBOARD
  ?? '/home/ibrahim/AP_work/Activepieces_v/pieces-team/dashboard';
const QA_FILE = join(TEAM_DASHBOARD, 'data', 'qa.json');

const USAGE = 'usage: node scripts/backfill-qa-sweeps.mjs --weeks=YYYY-Wnn..YYYY-Wnn [--live-latest] [--force] [--apply] [--verbose]';
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const range = value('weeks');
if (!/^\d{4}-W\d{2}\.\.\d{4}-W\d{2}$/.test(range ?? '')) { console.error(USAGE); process.exit(2); }
const [from, to] = range.split('..');
const apply = flag('apply');
const liveLatest = flag('live-latest');
const force = flag('force');
const verbose = flag('verbose');

const qa = JSON.parse(readFileSync(QA_FILE, 'utf8'));
const archive = readArchive(ARCHIVE);
const weeks = archive.weeks.filter((w) => w.week >= from && w.week <= to);
if (!weeks.length) { console.error(`no archived weeks in ${range}`); process.exit(1); }
const newest = archive.weeks.at(-1)?.week;

const line = (w, block, mode) => {
  const people = Object.entries(block.byPerson).map(([p, r]) => `${p} ${r.fixed}${typeof r.assigned === 'number' ? `/${r.assigned}` : ''}`).join(' · ');
  const extra = block.unassigned.fixed ? ` · unassigned ${block.unassigned.fixed}` : '';
  const board = typeof block.open === 'number' ? ` · in review ${block.inReview} · in progress ${block.inProgress} · open ${block.open}` : '';
  return `${w.week} (${mode}): ${block.fixed}/${block.total} fixed · +${block.fixedThisWeek} this week · ${people}${extra}${board} · ${block.projects.length} project${block.projects.length === 1 ? '' : 's'}`;
};

const kept = [];
const updated = weeks.filter((w) => {
  if (w.qaSweeps && !force) { kept.push(w.week); return false; }
  return true;
}).map((w) => {
  const window = windowForWeekId(w.week);
  const live = liveLatest && w.week === newest;
  const block = qaSweepsForWindow(qa, window, live ? {} : { asOf: window.end });
  const next = { ...w, qaSweeps: block };
  validateSnapshot(next);
  const had = w.qaSweeps ? ' (replacing the recorded block)' : '';
  console.log(line(w, block, live ? `live, read ${qa.stamp}` : `dates as of ${window.end}`) + had);
  if (verbose) console.log(JSON.stringify(block, null, 2));
  return next;
});

if (kept.length) console.log(`kept as recorded (pass --force to restate): ${kept.join(', ')}`);
if (!updated.length) { console.log('nothing to restate'); process.exit(0); }
if (!apply) { console.log(`dry run — ${updated.length} week(s) would be restated; pass --apply to write`); process.exit(0); }
const byWeek = new Map(updated.map((w) => [w.week, w]));
writeArchive(ARCHIVE, { ...archive, weeks: archive.weeks.map((w) => byWeek.get(w.week) ?? w) });
console.log(`wrote ${updated.length} week(s) to ${ARCHIVE}`);
