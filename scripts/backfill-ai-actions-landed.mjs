#!/usr/bin/env node
// Restates the AI actions LANDED in weeks already archived, from the PRs
// GitHub says merged into main inside each week's window.
//
// The weekly AI-actions tile counts pieces, and a piece counts once. From W45
// the snapshot also records how many agent atomics the week's merged PRs added
// (aiActions.actionsLanded, see weekly/collect/ai-actions.mjs) — but it reads
// that off data/landings.json, a 21-day scan, so it can only ever measure the
// week being snapshotted. The weeks before it were sealed without the field.
// This is a RECONSTRUCTION, not a decision: the same rule
// (lib/discover.mjs discoverActionsLanded) applied to the same diffs, fetched
// per week instead of per 21 days. Nothing is inferred that GitHub does not keep.
//
// What moves: `aiActions.actionsLanded` on each week asked for, and nothing else
// — not the pieces counts, not the roster, not `builtAt`, not any other tile.
// A week whose aiActions is not `ok` is skipped and said so: a degraded tile
// draws nothing, and a measurement hung off it would be one the page never shows.
//
// FAIL LOUD, all or nothing. One files fetch that does not answer drops that
// PR's actions, and the week would be archived short, forever, as a measurement.
// So every week is fetched and checked BEFORE anything is written, and any lost
// call stops the run with the archive untouched.
//
// The same goes for a piece src/ file GitHub served WITHOUT a patch: a diff too
// large to serve comes back patch-less, and a file with no patch counts nothing.
// W39–W45 had twelve, all generated — eight new output-schemas.ts (#15981 added
// 2,875 lines of elevenlabs) and four i18n JSON files — and each is REBUILT
// from the file's contents rather than refused (scripts/rebuild-patch.mjs, the
// same rebuild the Saturday scan uses). A rebuild that does not check out
// against GitHub's own +/− totals is a failure like any other.
//
//   node scripts/backfill-ai-actions-landed.mjs --weeks 2026-W39..2026-W45 [--apply] [--verbose]
//   node scripts/backfill-ai-actions-landed.mjs --week 2026-W45 [--apply]
//
// Dry run by default: one line per week, `--verbose` adds the PRs behind it.
// Needs the gh CLI, logged in. About one API call per piece PR merged in the
// window (~50 a week), so a seven-week run is a few minutes, not a rate-limit risk.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive, writeArchive, validateSnapshot } from '../weekly/lib/archive.mjs';
import { actionsLandedForWindow } from '../weekly/collect/ai-actions.mjs';
import { PEOPLE } from '../weekly/collect/people.mjs';
import { discoverActionsLanded } from '../lib/discover.mjs';
import { isoWeekId, mondayOfWeekId, windowForWeekId } from '../lib/isoweek.mjs';
import { fillMissingPatches } from './rebuild-patch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = join(ROOT, 'weekly/data/weeks.json');
const REPO = 'activepieces/activepieces';
const USAGE = 'usage: node scripts/backfill-ai-actions-landed.mjs (--weeks YYYY-Wnn..YYYY-Wnn | --week YYYY-Wnn) [--apply] [--verbose]';

// The same piece roots and the same per-PR shape scripts/fetch-pr-states.mjs
// builds for the landing scan, so the rule sees exactly what it sees there.
const LANDING_ROOTS = ['packages/pieces/community/', 'packages/pieces/core/'];
const LIST_LIMIT = 1000;

const ghText = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const gh = (args) => JSON.parse(ghText(args));

// --- arguments ---------------------------------------------------------------
// A week id exists only if it round-trips (weekly/snapshot.mjs requireWeekId):
// '2026-W54' resolves to a Monday in the next ISO year, and a typo here would
// restate a week nobody asked for.
const WEEK_RE = /^\d{4}-W\d{2}$/;
function requireWeekId(value) {
  if (!WEEK_RE.test(value ?? '') || isoWeekId(mondayOfWeekId(value)) !== value) {
    throw new Error(`not a real ISO week: ${JSON.stringify(value)} — ${USAGE}`);
  }
  return value;
}

const nextWeekId = (weekId) => {
  const monday = new Date(`${mondayOfWeekId(weekId)}T00:00:00Z`);
  return isoWeekId(new Date(monday.getTime() + 7 * 864e5));
};

function parseArgs(argv) {
  const known = new Set(['--weeks', '--week', '--apply', '--verbose']);
  for (let i = 0; i < argv.length; i += 1) {
    if (!known.has(argv[i])) throw new Error(`unknown argument ${JSON.stringify(argv[i])} — ${USAGE}`);
    if (argv[i] === '--weeks' || argv[i] === '--week') i += 1;
  }
  const value = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  const range = value('--weeks');
  const single = value('--week');
  if ((range === undefined) === (single === undefined)) throw new Error(`pass exactly one of --weeks or --week — ${USAGE}`);
  let weeks;
  if (single !== undefined) {
    weeks = [requireWeekId(single)];
  } else {
    const [from, to] = String(range).split('..');
    requireWeekId(from);
    requireWeekId(to);
    if (from > to) throw new Error(`--weeks ${range} runs backwards`);
    weeks = [];
    for (let w = from; w <= to; w = nextWeekId(w)) weeks.push(w);
  }
  return { weeks, apply: argv.includes('--apply'), verbose: argv.includes('--verbose') };
}

// --- one week ------------------------------------------------------------------
// The window by explicit UTC instants, not bare dates: the page counts a PR by
// the UTC day of its merge (actionsLandedForWindow), and a date-only search
// leaves which timezone GitHub reads it in to GitHub. The block is then built by
// the collector's own helper, so the archived shape is the snapshot's shape.
function measureWeek(weekId) {
  const window = windowForWeekId(weekId);
  const search = `merged:${window.start}T00:00:00Z..${window.end}T23:59:59Z base:main`;
  const merged = gh(['pr', 'list', '--repo', REPO, '--state', 'merged', '--search', search,
    '--limit', String(LIST_LIMIT), '--json', 'number,files,author,mergedAt,baseRefName']);
  // `gh pr list` truncates silently at its limit; a full page is a list that
  // may have stopped short, and a short list is a short count.
  if (merged.length >= LIST_LIMIT) throw new Error(`${weekId}: ${merged.length} merged PRs hit the list limit — the list may be truncated`);

  const piecePrs = merged.filter((p) => (p.files ?? []).some((f) => LANDING_ROOTS.some((r) => f.path?.startsWith(r))));
  const withPatches = [];
  const failures = [];
  const rebuilt = [];
  for (const pr of piecePrs) {
    let files;
    try {
      files = gh(['api', '--paginate', `repos/${REPO}/pulls/${pr.number}/files?per_page=100`]);
    } catch (e) {
      failures.push(`PR #${pr.number} files unavailable (${e.message.split('\n')[0]})`);
      continue;
    }
    const filled = fillMissingPatches(files, pr.number);
    rebuilt.push(...filled.rebuilt);
    failures.push(...filled.failures);
    withPatches.push({ number: pr.number, base: pr.baseRefName ?? null, mergedAt: pr.mergedAt,
      author: pr.author?.login ?? null, files });
  }
  const block = actionsLandedForWindow({ since: window.start, actionsLanded: discoverActionsLanded(withPatches) }, window);
  return { window, block, failures, rebuilt, scanned: piecePrs.length, merged: merged.length };
}

// --- reporting -----------------------------------------------------------------
const signed = (n) => (n < 0 ? `−${-n}` : `+${n}`);

// The people the tile draws a row for that week, anyone else on the team who
// moved the number, and `others` always — so the line adds up to its total.
function line(weekId, block, targets) {
  const shown = PEOPLE.filter((p) => block.byPerson[p] !== 0 || targets?.[p] !== undefined);
  const parts = [...shown, 'others'].map((p) => `${p} ${signed(block.byPerson[p])}`);
  return `${weekId}  total ${signed(block.total)} · ${parts.join(' · ')} · ${block.prs.length} ${block.prs.length === 1 ? 'PR' : 'PRs'}`;
}

function main(argv) {
  const { weeks, apply, verbose } = parseArgs(argv);
  const archive = readArchive(ARCHIVE);

  const patched = [];
  const failures = [];
  for (const weekId of weeks) {
    const week = archive.weeks.find((w) => w.week === weekId);
    if (!week) { console.log(`${weekId}  not in the archive — skipped`); continue; }
    if (week.aiActions?.status !== 'ok') { console.log(`${weekId}  aiActions is ${week.aiActions?.status ?? 'absent'} — skipped`); continue; }
    const m = measureWeek(weekId);
    if (m.failures.length) {
      failures.push(...m.failures.map((f) => `${weekId}: ${f}`));
      console.log(`${weekId}  INCOMPLETE — ${m.failures.length} call(s) failed; not archived`);
      continue;
    }
    week.aiActions.actionsLanded = m.block;
    validateSnapshot(week);
    patched.push(weekId);
    console.log(line(weekId, m.block, week.targets?.aiActions));
    // Always, not only with --verbose: a count read off a rebuilt patch is part
    // of how the number was made, and the operator should see it before --apply.
    for (const r of m.rebuilt) console.log(`    patch rebuilt from file contents: ${r}`);
    if (verbose) {
      console.log(`    ${m.merged} PRs merged into main ${m.window.start}..${m.window.end}, ${m.scanned} touched a piece`);
      for (const p of m.block.prs) {
        const pieces = Object.entries(p.pieces).map(([slug, n]) => `${slug} ${signed(n)}`).join(', ');
        console.log(`    #${p.pr} ${p.author ?? '(no author)'} ${signed(p.n)}: ${pieces}`);
      }
    }
  }

  if (failures.length) {
    for (const f of failures) console.error(`✗ ${f}`);
    throw new Error(`${failures.length} call(s) failed — nothing written; re-run when GitHub answers`);
  }
  if (!apply) {
    console.log('\ndry run — pass --apply to write weekly/data/weeks.json');
    return;
  }
  if (!patched.length) {
    console.log('\nnothing to write');
    return;
  }
  writeArchive(ARCHIVE, archive);
  console.log(`\n✓ weekly/data/weeks.json updated: aiActions.actionsLanded on ${patched.join(', ')}`);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
}
